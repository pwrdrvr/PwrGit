import {
  err,
  formatBytes,
  normalizeExcludes,
  ok,
  RECLAIM_DEFAULT_EXCLUDES,
  type ReclaimEntry,
  type ReclaimPlan,
  type Result
} from "@pwrgit/shared";
import { pathSize } from "../util/dir-size";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";

/**
 * `git clean -Xd` — delete the ignored files and leave everything else.
 *
 * This is a **separate operation from discard-all** (`discardAllChanges` in
 * git-service.ts), which runs a bare `clean -fd` and must keep excluding
 * ignored paths. Two commands, two blast radii; neither may quietly acquire
 * the other's flags.
 *
 * Three invariants, none of them cosmetic:
 *
 * - **`-X`, never `-x`.** `-x` additionally deletes untracked files that no
 *   `.gitignore` covers — work in progress the user has not committed yet. The
 *   flag is one character away and there is no UI for it here on purpose.
 * - **The preview is git's own dry run, and the deletion re-runs git.** The
 *   parsed paths are shown to the user and then thrown away; `reclaimIgnored`
 *   passes the same spare patterns to a real `clean` rather than feeding the
 *   list back. So a mis-parse can only mis-*draw* a row — it can never widen
 *   what gets deleted. Do not "optimize" this into `clean -- <paths>`.
 * - **Single `-f`.** Git refuses to delete a directory that holds its own
 *   `.git` unless `-f` is given twice, which is how a nested clone inside an
 *   ignored directory survives. One `-f` is the whole authorization we want.
 *
 * Ignored does not mean worthless: `.env` files, local databases and keys have
 * no git object behind them, so this is unrecoverable. `RECLAIM_DEFAULT_EXCLUDES`
 * is the default guard and the caller may narrow it, never widen it silently.
 */

/** Rows kept in a plan. Beyond this the plan is `truncated` — a preview is for
 *  judging a decision, and nobody reads the 501st path. */
export const RECLAIM_PLAN_ROW_CAP = 500;

/** Paths accepted from one dry run before the rest are summarized away. */
const RECLAIM_PARSE_CAP = 5_000;

/**
 * Git translates its own messages, and "Would remove " is one of them. Forcing
 * C for this command is what makes the prefix a stable token rather than a
 * guess about the user's locale — and `core.quotePath=false` is what keeps a
 * non-ASCII path readable instead of `"\346\227\245"`.
 */
const PARSEABLE_DRY_RUN = {
  env: {
    ...NO_OPTIONAL_LOCKS.env,
    LC_ALL: "C",
    LANGUAGE: "C",
    LANG: "C"
  }
};

const WOULD_REMOVE = "Would remove ";

/**
 * Turn "spare these patterns" into git arguments — and note the `!`.
 *
 * **`-e <pattern>` does not protect anything under `-X`.** `-e` adds to git's
 * ignore rules, and `-X` deletes exactly the ignored set, so `-e .env` makes
 * `.env` *more* likely to be deleted, not less. Verified against real git:
 * `clean -Xdn -e '.env'` still reports `Would remove .env`.
 *
 * A **negated** command-line pattern is what spares a path: `-e '!.env'`
 * un-ignores it, and `-X` then has no reason to touch it. Command-line
 * excludes sit at the top of git's precedence stack, so this beats the rule in
 * `.gitignore` that put the file in scope. Globs and trailing-slash directory
 * patterns work the same way (`!*.sqlite`, `!.vscode/`).
 *
 * `worktree-reclaim.test.ts` pins this against real git in both directions.
 * If that test ever looks redundant, it is the only thing standing between a
 * default "spare list" and a command that deletes precisely the files on it.
 */
export function spareArgs(spares: readonly string[]): string[] {
  return spares.flatMap((pattern) => ["-e", `!${pattern}`]);
}

/**
 * Parse `git clean -Xdn` output into repository-relative paths.
 *
 * Anything that is not a `Would remove …` line is dropped (git also prints
 * "Skipping repository …" for nested clones, which is information, not a
 * deletion). Absolute paths and `..` escapes are dropped too: git does not
 * emit them, so one appearing means the line was not what we think it is, and
 * the honest response to that is to show fewer rows rather than a wrong one.
 */
export function parseCleanDryRun(stdout: string): {
  paths: string[];
  truncated: boolean;
} {
  const paths: string[] = [];
  let truncated = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(WOULD_REMOVE)) continue;
    const path = line.slice(WOULD_REMOVE.length);
    if (path === "") continue;
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) continue;
    if (path.split("/").includes("..")) continue;
    if (paths.length >= RECLAIM_PARSE_CAP) {
      truncated = true;
      break;
    }
    paths.push(path);
  }
  return { paths, truncated };
}

export type ReclaimPreviewInput = {
  worktreeId: string;
  repoName: string;
  branch: string;
  path: string;
  excludes?: readonly string[];
};

export type ReclaimPreviewOptions = {
  signal?: AbortSignal;
  /** Injected in tests; production measures the real filesystem. */
  sizeOf?: (target: string, signal?: AbortSignal) => Promise<{
    bytes: number;
    partial: boolean;
  }>;
};

/**
 * What reclaiming this worktree would delete, biggest first.
 *
 * Read-only: one `git clean -Xdn` plus a bounded `stat` walk per reported
 * path. Sizing stops at the signal, so a cancelled preview returns the rows it
 * had rather than nothing.
 */
export async function previewReclaim(
  git: GitExec,
  input: ReclaimPreviewInput,
  options: ReclaimPreviewOptions = {}
): Promise<Result<ReclaimPlan>> {
  const excludes = normalizeExcludes([
    ...(input.excludes ?? RECLAIM_DEFAULT_EXCLUDES)
  ]);
  const args = [
    "-c",
    "core.quotePath=false",
    "clean",
    "-X",
    "-d",
    "--dry-run",
    ...spareArgs(excludes)
  ];
  const raw = await git(args, input.path, {
    ...PARSEABLE_DRY_RUN,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;

  const parsed = parseCleanDryRun(checked.value.stdout);
  const sizeOf =
    options.sizeOf ??
    (async (target, signal) => {
      const measured = await pathSize(
        target,
        signal === undefined ? {} : { signal }
      );
      return { bytes: measured.bytes, partial: measured.partial };
    });

  const entries: ReclaimEntry[] = [];
  let totalBytes = 0;
  for (const path of parsed.paths) {
    const isDirectory = path.endsWith("/");
    // Git paths are always forward-slash, on every platform. Joining with
    // node:path would produce separators git never emitted.
    const absolute = `${input.path.replace(/[/\\]+$/, "")}/${path}`;
    const measured = options.signal?.aborted === true
      ? { bytes: 0, partial: true }
      : await sizeOf(absolute, options.signal);
    const entry: ReclaimEntry = {
      path,
      isDirectory,
      sizeBytes: measured.bytes
    };
    if (measured.partial) entry.sizePartial = true;
    entries.push(entry);
    totalBytes += measured.bytes;
  }
  entries.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));

  return ok({
    worktreeId: input.worktreeId,
    repoName: input.repoName,
    branch: input.branch,
    path: input.path,
    excludes,
    entries: entries.slice(0, RECLAIM_PLAN_ROW_CAP),
    totalBytes,
    pathCount: entries.length,
    truncated: parsed.truncated || entries.length > RECLAIM_PLAN_ROW_CAP
  });
}

/**
 * Delete the ignored files in one worktree. The caller owns the confirm and
 * the repository lock; this is only the Git command and its error shape.
 */
export async function reclaimIgnored(
  git: GitExec,
  cwd: string,
  excludes: readonly string[],
  options: { signal?: AbortSignal } = {}
): Promise<Result<void>> {
  const args = [
    "clean",
    "-X",
    "-d",
    "--force",
    ...spareArgs(normalizeExcludes([...excludes]))
  ];
  const raw = await git(
    args,
    cwd,
    options.signal === undefined ? undefined : { signal: options.signal }
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) {
    return err({
      kind: "git",
      code: "clean_failed",
      message: `Could not delete the ignored files: ${checked.error.message}`
    });
  }
  return ok(undefined);
}

/** "1.2 GB in 14 paths" — the one phrasing the confirm and the summary share. */
export function describePlan(plan: ReclaimPlan): string {
  const paths = plan.pathCount === 1 ? "path" : "paths";
  return `${formatBytes(plan.totalBytes)} in ${plan.pathCount} ${paths}`;
}
