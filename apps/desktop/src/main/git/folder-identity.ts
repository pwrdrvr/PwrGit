import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  comparableRoot,
  err,
  findRootOverlaps,
  lastConfigEntry,
  ok,
  type FolderIdentityReport,
  type FolderIdentitySource,
  type FolderInclude,
  type FolderProfileIdentity,
  type FolderRepoIdentity,
  type FolderSyncPlan,
  type IdentityConfigEntry,
  type OutsideGitIdentity,
  type Result
} from "@pwrgit/shared";
import { mapLimit } from "../util/map-limit";
import { globalConfigFile, readConfigEntries, resolveOutsideIdentity } from "./commit-identity";
import type { GitExec } from "./dugite";

/**
 * Identity by folder: an `[includeIf "gitdir:<root>/"]` in the global Git
 * config per profile root, pointing at one PwrGit-written file per profile.
 *
 * Three facts shape this module (design/Git Identity by Folder, turn 1):
 * - an include overrides only what comes before it in the file, so PwrGit's
 *   includes are removed and re-appended last on every write;
 * - `gitdir:` matches a repository's `.git`, so a folder is never asked —
 *   each indexed repository is;
 * - an included file reports scope `global` with itself as the origin, which
 *   is how PwrGit tells its own include from the user's.
 */

/** Indexed repositories asked at once. */
const REPO_READ_CONCURRENCY = 6;

const MANAGED_PREFIX = ".gitconfig-pwrgit-";
const REPO_IDENTITY_KEYS = "^(user|author)\\.(name|email)$";

export type FolderProfileRow = {
  id: string;
  name: string;
  mono: string;
  email: string;
  authorName: string | null;
  roots: string[];
};

export type FolderRepoRow = { id: string; profileId: string; name: string; path: string };

/** Case-insensitive file systems hand Git paths in whatever case they were typed. */
export function caseInsensitivePaths(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** The include file PwrGit writes for `profileId`, beside the global file.
 *  Profile ids are stable slugs, so a rename never orphans the file. */
export function managedIncludeFile(globalFile: string, profileId: string): string {
  return join(dirname(globalFile), `${MANAGED_PREFIX}${profileId}`);
}

function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  return comparableRoot(a, caseInsensitive) === comparableRoot(b, caseInsensitive);
}

/** Whether `path` is an include file PwrGit owns. Anything else is the user's. */
export function isManagedInclude(
  globalFile: string,
  path: string,
  caseInsensitive = caseInsensitivePaths()
): boolean {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash === -1 ? "" : normalized.slice(0, slash);
  return (
    normalized.slice(slash + 1).startsWith(MANAGED_PREFIX) &&
    samePath(dir, dirname(globalFile), caseInsensitive)
  );
}

/** Wildmatch treats these as pattern syntax; a root containing one is literal. */
function escapeGlob(path: string): string {
  return path.replace(/[*?[\]\\]/g, (char) => `\\${char}`);
}

/**
 * `gitdir/i:/Users/rowan/Work/` — recursive (trailing slash), forward
 * slashes even on Windows, case-insensitive where the file system is.
 */
export function includeCondition(
  root: string,
  platform: NodeJS.Platform = process.platform
): string {
  const path = comparableRoot(root, false);
  return `${caseInsensitivePaths(platform) ? "gitdir/i" : "gitdir"}:${escapeGlob(path)}/`;
}

/** A config value Git reads back verbatim. */
function quoteConfigValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function includeFileContent(profile: FolderProfileRow): string {
  const label = profile.name.replace(/[\r\n]+/g, " ");
  const lines = [
    `# Written by PwrGit for the “${label}” profile’s repo folders.`,
    "# PwrGit rewrites this file when the profile changes. Edit the profile in PwrGit instead.",
    "[user]",
    `\temail = ${quoteConfigValue(profile.email.trim())}`
  ];
  const name = profile.authorName?.trim() ?? "";
  if (name !== "") lines.push(`\tname = ${quoteConfigValue(name)}`);
  return `${lines.join("\n")}\n`;
}

/** Profile fields a config file can carry: one line, no control characters. */
function writable(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The includes PwrGit wants, in write order. Shallower roots first, so in a
 * nested pair the deeper (more specific) one is read last and wins; overlaps
 * are refused at save time, but older profiles can still carry one.
 */
export function desiredIncludes(
  profiles: readonly FolderProfileRow[],
  globalFile: string,
  platform: NodeJS.Platform = process.platform
): {
  includes: (FolderInclude & { depth: number })[];
  files: Map<string, string>;
  skipped: FolderSyncPlan["skipped"];
} {
  const includes: (FolderInclude & { depth: number })[] = [];
  const files = new Map<string, string>();
  const skipped: FolderSyncPlan["skipped"] = [];
  for (const profile of profiles) {
    const email = profile.email.trim();
    const roots = profile.roots.map((root) => root.trim()).filter((root) => root !== "");
    if (email === "" || !writable(email) || !writable(profile.authorName ?? "")) {
      skipped.push({ profileId: profile.id, name: profile.name, reason: "no_email" });
      continue;
    }
    if (roots.length === 0) {
      skipped.push({ profileId: profile.id, name: profile.name, reason: "no_roots" });
      continue;
    }
    const path = managedIncludeFile(globalFile, profile.id);
    files.set(path, includeFileContent(profile));
    for (const root of roots) {
      includes.push({
        condition: includeCondition(root, platform),
        path,
        depth: comparableRoot(root, false).split("/").length
      });
    }
  }
  includes.sort((a, b) => a.depth - b.depth);
  return { includes, files, skipped };
}

/** `includeif.<condition>.path` → the condition, case preserved. */
function includeConditionOf(rawKey: string): string | null {
  if (!rawKey.toLowerCase().startsWith("includeif.") || !rawKey.toLowerCase().endsWith(".path")) {
    return null;
  }
  return rawKey.slice("includeif.".length, -".path".length);
}

/** PwrGit's includes now in the global file, in file order. */
export function currentManagedIncludes(
  lines: readonly { rawKey: string; value: string }[],
  globalFile: string
): FolderInclude[] {
  const found: FolderInclude[] = [];
  for (const line of lines) {
    const condition = includeConditionOf(line.rawKey);
    if (condition !== null && isManagedInclude(globalFile, line.value)) {
      found.push({ condition, path: line.value });
    }
  }
  return found;
}

/**
 * Whether PwrGit's includes come after every identity key in the global file.
 * An identity key appended later — `git config --global user.email` on a file
 * that had no `[user]` — silently beats every include before it.
 */
export function managedIncludesAreLast(
  lines: readonly { rawKey: string; value: string }[],
  globalFile: string
): boolean {
  let lastIdentity = -1;
  let firstManaged = Number.POSITIVE_INFINITY;
  lines.forEach((line, index) => {
    const key = line.rawKey.toLowerCase();
    if (/^(user|author|committer)\.(name|email)$/.test(key)) lastIdentity = index;
    const condition = includeConditionOf(line.rawKey);
    if (condition !== null && isManagedInclude(globalFile, line.value)) {
      firstManaged = Math.min(firstManaged, index);
    }
  });
  return firstManaged === Number.POSITIVE_INFINITY || firstManaged > lastIdentity;
}

export type FolderIdentityDeps = {
  git: GitExec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/** `git config --global -z --list`, keys with their case (conditions are
 *  case-sensitive paths on Linux). */
async function readGlobalLines(git: GitExec): Promise<{ rawKey: string; value: string }[]> {
  const raw = await git(["config", "--global", "-z", "--list"], tmpdir());
  // A missing global file exits non-zero with nothing to list.
  if (!raw.ok || raw.value.exitCode !== 0) return [];
  return raw.value.stdout
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const newline = record.indexOf("\n");
      return newline === -1
        ? { rawKey: record, value: "true" }
        : { rawKey: record.slice(0, newline), value: record.slice(newline + 1) };
    });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function managedFilesOnDisk(globalFile: string): Promise<string[]> {
  const dir = dirname(globalFile);
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.startsWith(MANAGED_PREFIX)).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** What turning the switch on (or off) writes, without writing it. */
export async function planFolderSync(
  deps: FolderIdentityDeps,
  profiles: readonly FolderProfileRow[],
  enabled: boolean
): Promise<FolderSyncPlan> {
  const globalFile = globalConfigFile(deps.env);
  const lines = await readGlobalLines(deps.git);
  const remove = currentManagedIncludes(lines, globalFile);
  const onDisk = await managedFilesOnDisk(globalFile);
  if (!enabled) {
    return { enabled, globalFile, remove, add: [], files: [], deleteFiles: onDisk, skipped: [] };
  }
  const desired = desiredIncludes(profiles, globalFile, deps.platform);
  const files: FolderSyncPlan["files"] = [];
  for (const [path, content] of desired.files) {
    const existing = await readText(path);
    files.push({ path, content, exists: existing !== null });
  }
  const wanted = new Set(desired.files.keys());
  return {
    enabled,
    globalFile,
    remove,
    add: desired.includes.map(({ condition, path }) => ({ condition, path })),
    files,
    deleteFiles: onDisk.filter((path) => !wanted.has(path)),
    skipped: desired.skipped
  };
}

/**
 * Whether the config already says what `plan` would write: same includes in
 * the same order, after every identity key, and every file's content equal.
 * Lets a profile change that touches no identity field skip the write.
 */
export async function planIsApplied(
  deps: FolderIdentityDeps,
  plan: FolderSyncPlan
): Promise<boolean> {
  const lines = await readGlobalLines(deps.git);
  const current = currentManagedIncludes(lines, plan.globalFile);
  const sameIncludes =
    current.length === plan.add.length &&
    current.every((entry, i) => entry.condition === plan.add[i]?.condition && entry.path === plan.add[i]?.path);
  if (!sameIncludes || !managedIncludesAreLast(lines, plan.globalFile)) return false;
  if (plan.deleteFiles.length > 0) return false;
  for (const file of plan.files) {
    if ((await readText(file.path)) !== file.content) return false;
  }
  return true;
}

function configFailure(action: string, stderr: string): Result<never> {
  return err({
    kind: "git",
    code: "config_write_failed",
    message: `Git couldn’t ${action}: ${stderr.trim().split(/\r?\n/).pop() ?? ""}`.trim(),
    detail: stderr.trim()
  });
}

/**
 * Apply `plan`: remove PwrGit's includes, write the include files, append
 * the includes at the end of the global file, delete orphaned files. Only
 * PwrGit's own entries and files are touched.
 */
export async function applyFolderSync(
  deps: FolderIdentityDeps,
  plan: FolderSyncPlan
): Promise<Result<null>> {
  const cwd = tmpdir();
  for (const entry of plan.remove) {
    const raw = await deps.git(
      ["config", "--global", "--fixed-value", "--unset-all", `includeIf.${entry.condition}.path`, entry.path],
      cwd
    );
    if (!raw.ok) return raw;
    // 5: nothing matched — already gone, which is the goal.
    if (raw.value.exitCode !== 0 && raw.value.exitCode !== 5) {
      return configFailure(`remove the include for ${entry.condition}`, raw.value.stderr);
    }
  }
  for (const file of plan.files) {
    try {
      await writeFile(file.path, file.content, "utf8");
    } catch (cause) {
      return err({
        kind: "git",
        code: "config_write_failed",
        message: `PwrGit couldn’t write ${file.path}.`,
        detail: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  for (const entry of plan.add) {
    const raw = await deps.git(
      ["config", "--global", "--add", `includeIf.${entry.condition}.path`, entry.path],
      cwd
    );
    if (!raw.ok) return raw;
    if (raw.value.exitCode !== 0) {
      return configFailure(`add the include for ${entry.condition}`, raw.value.stderr);
    }
  }
  for (const path of plan.deleteFiles) {
    // Refuse anything outside PwrGit's own naming, whatever the plan says.
    if (!isManagedInclude(plan.globalFile, path) || basename(path) === basename(plan.globalFile)) continue;
    await rm(path, { force: true }).catch(() => undefined);
  }
  return ok(null);
}

/** Where the winning entry came from, from the profile's point of view. */
export function classifySource(
  entry: IdentityConfigEntry | undefined,
  includeFile: string,
  globalFile: string,
  caseInsensitive = caseInsensitivePaths()
): FolderIdentitySource {
  if (entry === undefined) return "none";
  switch (entry.scope) {
    case "local":
    case "worktree":
    case "command":
      return "local";
    case "system":
      return "system";
    default:
      if (samePath(entry.origin, includeFile, caseInsensitive)) return "pwrgit";
      if (isManagedInclude(globalFile, entry.origin, caseInsensitive)) return "pwrgit-other";
      if (samePath(entry.origin, globalFile, caseInsensitive)) return "global";
      return "include";
  }
}

/** One repository's identity outside PwrGit, against its profile's. */
export function repoIdentity(
  repo: FolderRepoRow,
  entries: readonly IdentityConfigEntry[],
  profile: FolderProfileRow,
  includeFile: string,
  globalFile: string,
  caseInsensitive = caseInsensitivePaths()
): FolderRepoIdentity {
  // `author.*` outranks `user.*` for the author line at every scope.
  const emailEntry = lastConfigEntry(entries, "author.email") ?? lastConfigEntry(entries, "user.email");
  const nameEntry = lastConfigEntry(entries, "author.name") ?? lastConfigEntry(entries, "user.name");
  const email = emailEntry?.value.trim() ?? null;
  const authorName = nameEntry?.value.trim() ?? null;
  const wantName = profile.authorName?.trim() ?? "";
  const matches =
    profile.email.trim() !== "" &&
    email !== null &&
    email.toLowerCase() === profile.email.trim().toLowerCase() &&
    (wantName === "" || authorName === wantName);
  return {
    repoId: repo.id,
    name: repo.name,
    path: repo.path,
    email,
    authorName,
    source: classifySource(emailEntry, includeFile, globalFile, caseInsensitive),
    origin: emailEntry?.origin ?? null,
    matches
  };
}

/** Every profile's roots, overlaps and repositories, asked of Git. */
export async function inspectFolderIdentity(
  deps: FolderIdentityDeps,
  input: {
    enabled: boolean;
    profiles: readonly FolderProfileRow[];
    repos: readonly FolderRepoRow[];
    /** Narrow the per-repo reads (and the answer) to one profile. */
    profileId?: string;
  }
): Promise<FolderIdentityReport> {
  const globalFile = globalConfigFile(deps.env);
  const caseInsensitive = caseInsensitivePaths(deps.platform);
  const shown =
    input.profileId === undefined
      ? input.profiles
      : input.profiles.filter((profile) => profile.id === input.profileId);
  const byProfile = new Map(shown.map((profile) => [profile.id, profile] as const));
  const repos = input.repos.filter((repo) => byProfile.has(repo.profileId));
  const identities = new Map<string, FolderRepoIdentity>();
  const machinePromise: Promise<OutsideGitIdentity> = resolveOutsideIdentity(deps.git, tmpdir(), deps.env);
  await mapLimit(repos, REPO_READ_CONCURRENCY, async (repo) => {
    const profile = byProfile.get(repo.profileId);
    if (profile === undefined) return;
    const entries = await readConfigEntries(deps.git, repo.path, REPO_IDENTITY_KEYS);
    identities.set(
      repo.id,
      repoIdentity(repo, entries, profile, managedIncludeFile(globalFile, profile.id), globalFile, caseInsensitive)
    );
  });
  const profiles: FolderProfileIdentity[] = shown.map((profile) => ({
    profileId: profile.id,
    name: profile.name,
    mono: profile.mono,
    email: profile.email,
    authorName: profile.authorName,
    roots: profile.roots,
    overlaps: findRootOverlaps(
      profile.roots,
      input.profiles.filter((other) => other.id !== profile.id),
      caseInsensitive
    ),
    includeFile: managedIncludeFile(globalFile, profile.id),
    repos: repos
      .filter((repo) => repo.profileId === profile.id)
      .flatMap((repo) => identities.get(repo.id) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
  }));
  return { enabled: input.enabled, globalFile, machine: await machinePromise, profiles };
}

/**
 * Unset a repository's own identity so its profile's folder identity wins:
 * `user.email` and `author.email`, plus the names when the profile sets one.
 * Local scope only; a missing key is already the goal.
 */
export async function clearRepoOverride(
  git: GitExec,
  repoPath: string,
  profile: FolderProfileRow
): Promise<Result<null>> {
  const keys = ["user.email", "author.email"];
  if ((profile.authorName?.trim() ?? "") !== "") keys.push("user.name", "author.name");
  for (const key of keys) {
    const raw = await git(["config", "--local", "--unset-all", key], repoPath);
    if (!raw.ok) return raw;
    if (raw.value.exitCode !== 0 && raw.value.exitCode !== 5) {
      return configFailure(`remove ${key} from ${repoPath}`, raw.value.stderr);
    }
  }
  return ok(null);
}
