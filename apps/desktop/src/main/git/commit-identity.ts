import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  err,
  ok,
  type CommitIdentityInspection,
  type CommitSigning,
  type GitConfigScope,
  type GitPerson,
  type IdentityConfigEntry,
  type IdentityEnvOverride,
  type OutsideGitIdentity,
  type PwrGitIdentityPrediction,
  type RecordedCommitIdentity,
  type Result
} from "@pwrgit/shared";
import type { GitExec } from "./dugite";

/**
 * The identity a PwrGit operation records. `email` may be empty: a profile
 * with no commit email follows Git's own configuration instead of writing an
 * empty address (Git accepts `-c user.email=` and records `<>`).
 */
export type CommitIdentity = { name?: string; email: string };

/** Environment variables that set a commit identity outright. */
export const IDENTITY_ENV_VARIABLES = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL"
] as const;

/**
 * Removes every inherited identity variable from a PwrGit commit's Git
 * process. A GUI app inherits whatever shell or launcher started it, so a
 * variable here is an accident far more often than a choice, and it beats
 * every config scope, `-c` included. An `undefined` overlay unsets the key:
 * Node leaves undefined values out of a child's environment.
 */
export const SCRUBBED_IDENTITY_ENV: Readonly<Record<string, undefined>> =
  Object.fromEntries(IDENTITY_ENV_VARIABLES.map((name) => [name, undefined]));

/** What a terminal's Git also lacks: only the per-command variables. `EMAIL`
 *  is a standing default Git consults when guessing, so it stays. */
const SCRUBBED_COMMAND_ENV: Readonly<Record<string, undefined>> = Object.fromEntries(
  IDENTITY_ENV_VARIABLES.filter((name) => name !== "EMAIL").map((name) => [name, undefined])
);

/**
 * `-c` arguments that make Git record exactly `identity`, whatever any config
 * scope says.
 *
 * `user.*` alone is not enough: `author.*` and `committer.*` outrank it at
 * every scope, so a repository's `author.email` used to win over the profile
 * while the commit footer promised the profile. A `-c` outranks every file,
 * and setting all three keys leaves nothing for a file to decide.
 *
 * A half-empty profile overrides only its own half. With no email, PwrGit
 * also forbids Git from guessing one (`user.useConfigOnly`): the guess is a
 * login@hostname address no forge can attribute, and refusing is better than
 * recording it.
 */
export function commitIdentityArgs(identity: CommitIdentity): string[] {
  const args: string[] = [];
  const email = identity.email.trim();
  const name = identity.name?.trim() ?? "";
  if (email !== "") {
    for (const key of ["user.email", "author.email", "committer.email"]) {
      args.push("-c", `${key}=${email}`);
    }
  } else {
    args.push("-c", "user.useConfigOnly=true");
  }
  if (name !== "") {
    for (const key of ["user.name", "author.name", "committer.name"]) {
      args.push("-c", `${key}=${name}`);
    }
  }
  return args;
}

/** `Name <email> 1700000000 -0400` → the person. Null for anything else. */
export function parseIdent(line: string): GitPerson | null {
  const match = /^(.*?)\s*<([^>]*)>/.exec(line.trim());
  if (match === null) return null;
  return { name: match[1] ?? "", email: match[2] ?? "" };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * Git's refusal, as one sentence. An identity refusal opens with a generic
 * "Author identity unknown" banner and a how-to; the `fatal:` line at the end
 * is the one that says which half is missing.
 */
function refusal(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  const fatal = [...lines].reverse().find((line) => /^fatal:/i.test(line));
  const line = (fatal ?? firstLine(stderr)).replace(/^fatal:\s*/i, "");
  return line === "" ? "Git could not determine an identity." : line;
}

async function identVar(
  git: GitExec,
  cwd: string,
  args: string[],
  name: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT",
  env: Readonly<Record<string, undefined>>
): Promise<Result<GitPerson, string>> {
  const raw = await git([...args, "var", name], cwd, { env: { ...env } });
  if (!raw.ok) return err(raw.error.message);
  if (raw.value.exitCode !== 0) return err(refusal(raw.value.stderr));
  const person = parseIdent(raw.value.stdout);
  return person === null ? err("Git returned an identity PwrGit could not read.") : ok(person);
}

/**
 * What a PwrGit commit here records, asked of Git with the exact arguments
 * and environment `commitChanges` uses.
 */
export async function predictPwrGitIdentity(
  git: GitExec,
  cwd: string,
  identity: CommitIdentity
): Promise<PwrGitIdentityPrediction> {
  const args = commitIdentityArgs(identity);
  const [author, committer] = await Promise.all([
    identVar(git, cwd, args, "GIT_AUTHOR_IDENT", SCRUBBED_IDENTITY_ENV),
    identVar(git, cwd, args, "GIT_COMMITTER_IDENT", SCRUBBED_IDENTITY_ENV)
  ]);
  if (!author.ok || !committer.ok) {
    const message = !author.ok ? author.error : committer.ok ? "" : committer.error;
    const problem = /\bname\b/i.test(message)
      ? "no_name"
      : /\bemail\b/i.test(message)
        ? "no_email"
        : "failed";
    return { ok: false, problem, message };
  }
  return {
    ok: true,
    author: author.value,
    committer: committer.value,
    nameSource: (identity.name?.trim() ?? "") !== "" ? "profile" : "git",
    emailSource: identity.email.trim() !== "" ? "profile" : "git"
  };
}

/**
 * What Git resolves here without PwrGit: configured, guessed, or missing.
 *
 * `git var` succeeding proves nothing on its own. With no identity
 * configured, macOS Git builds `login@host.local` and exits 0, so the first
 * probe forbids guessing (`user.useConfigOnly`), and only a refusal there
 * earns the plain probe that tells a guess from nothing at all.
 */
export async function resolveOutsideIdentity(
  git: GitExec,
  cwd: string
): Promise<OutsideGitIdentity> {
  const strictArgs = ["-c", "user.useConfigOnly=true"];
  const [author, committer] = await Promise.all([
    identVar(git, cwd, strictArgs, "GIT_AUTHOR_IDENT", SCRUBBED_COMMAND_ENV),
    identVar(git, cwd, strictArgs, "GIT_COMMITTER_IDENT", SCRUBBED_COMMAND_ENV)
  ]);
  if (author.ok && committer.ok) {
    return { kind: "configured", author: author.value, committer: committer.value };
  }
  const guess = await identVar(git, cwd, [], "GIT_AUTHOR_IDENT", SCRUBBED_COMMAND_ENV);
  if (guess.ok) return { kind: "guessed", author: guess.value };
  return { kind: "missing", message: guess.error };
}

const IDENTITY_KEYS =
  "^(user\\.(name|email|useconfigonly|signingkey)|author\\.(name|email)|committer\\.(name|email)|commit\\.gpgsign|gpg\\.format)$";
const MACHINE_KEYS = "^user\\.(name|email)$";

const SCOPES: ReadonlySet<string> = new Set([
  "system",
  "global",
  "local",
  "worktree",
  "command"
]);

/**
 * `git config --show-scope --show-origin -z` records: `scope NUL origin NUL
 * key LF value NUL`. A bare boolean key (`[commit] gpgsign`) has no LF and no
 * value, which Git reads as true.
 */
export function parseConfigEntries(stdout: string): IdentityConfigEntry[] {
  const fields = stdout.split("\0");
  const entries: IdentityConfigEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const scope = fields[i] ?? "";
    const origin = fields[i + 1] ?? "";
    const pair = fields[i + 2] ?? "";
    const newline = pair.indexOf("\n");
    const key = (newline === -1 ? pair : pair.slice(0, newline)).toLowerCase();
    if (key === "") continue;
    entries.push({
      key,
      value: newline === -1 ? "true" : pair.slice(newline + 1),
      scope: SCOPES.has(scope) ? (scope as GitConfigScope) : "unknown",
      origin: origin.startsWith("file:")
        ? origin.slice("file:".length)
        : origin === "command line:"
          ? "command line"
          : origin
    });
  }
  return entries;
}

async function readConfigEntries(
  git: GitExec,
  cwd: string,
  pattern: string
): Promise<IdentityConfigEntry[]> {
  const raw = await git(
    ["config", "--show-scope", "--show-origin", "-z", "--get-regexp", pattern],
    cwd
  );
  // Exit 1 is "no key matched" — an answer, not a failure.
  if (!raw.ok || raw.value.exitCode !== 0) return [];
  return parseConfigEntries(raw.value.stdout);
}

/** Identity and signing config in force at `cwd`, lowest precedence first. */
export function readIdentityConfig(
  git: GitExec,
  cwd: string
): Promise<IdentityConfigEntry[]> {
  return readConfigEntries(git, cwd, IDENTITY_KEYS);
}

/** The value Git uses for `key`: the last one listed wins. */
export function lastValue(entries: IdentityConfigEntry[], key: string): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.key === key) return entries[i]!.value;
  }
  return null;
}

function truthy(value: string | null): boolean {
  return value !== null && /^(true|yes|on|1)$/i.test(value.trim());
}

/** Whether Git signs commits here, read from config alone. */
export function signingFromConfig(entries: IdentityConfigEntry[]): CommitSigning {
  if (!truthy(lastValue(entries, "commit.gpgsign"))) return { enabled: false };
  const format = (lastValue(entries, "gpg.format") ?? "openpgp").trim().toLowerCase();
  const key = lastValue(entries, "user.signingkey");
  return {
    enabled: true,
    format: format === "ssh" || format === "x509" ? format : "openpgp",
    key: key === null || key.trim() === "" ? null : key.trim()
  };
}

/** Identity variables in this process's environment. */
export function identityEnvOverrides(
  env: NodeJS.ProcessEnv = process.env
): IdentityEnvOverride[] {
  return IDENTITY_ENV_VARIABLES.flatMap((variable) => {
    const value = env[variable];
    return value === undefined || value === "" ? [] : [{ variable, value }];
  });
}

/**
 * Parse `git log --pretty=raw`. Raw is the one format that shows whether a
 * commit carries a signature header without verifying it: `%G?` runs the
 * verifier, and without `gpg.ssh.allowedSignersFile` it reports an SSH-signed
 * commit as `N`, the same as unsigned.
 */
export function parseRawLog(stdout: string): RecordedCommitIdentity[] {
  const commits: RecordedCommitIdentity[] = [];
  let current: (RecordedCommitIdentity & { inHeader: boolean }) | null = null;
  const finish = (): void => {
    if (current === null) return;
    const { inHeader: _inHeader, ...commit } = current;
    commits.push(commit);
  };
  for (const line of stdout.split("\n")) {
    const start = /^commit ([0-9a-f]{7,64})/.exec(line);
    if (start !== null) {
      finish();
      current = {
        hash: start[1]!,
        author: { name: "", email: "" },
        committer: { name: "", email: "" },
        coAuthors: [],
        signed: false,
        inHeader: true
      };
      continue;
    }
    if (current === null) continue;
    if (current.inHeader) {
      if (line === "") {
        current.inHeader = false;
      } else if (line.startsWith("author ")) {
        current.author = parseIdent(line.slice("author ".length)) ?? current.author;
      } else if (line.startsWith("committer ")) {
        current.committer = parseIdent(line.slice("committer ".length)) ?? current.committer;
      } else if (line.startsWith("gpgsig ") || line.startsWith("gpgsig-sha256 ")) {
        current.signed = true;
      }
      continue;
    }
    const trailer = /^ {4}Co-authored-by:\s*(.+?)\s*$/i.exec(line);
    if (trailer !== null) current.coAuthors.push(trailer[1]!);
  }
  finish();
  return commits;
}

export async function readRecentCommitIdentities(
  git: GitExec,
  cwd: string,
  limit = 6
): Promise<RecordedCommitIdentity[]> {
  const raw = await git(
    ["log", `-n${limit}`, "--pretty=raw", "--no-color", "HEAD", "--"],
    cwd
  );
  // An unborn branch has no HEAD to log; that is "no history", not an error.
  if (!raw.ok || raw.value.exitCode !== 0) return [];
  return parseRawLog(raw.value.stdout);
}

export type ProfileIdentity = {
  name: string;
  email: string;
  authorName: string | null;
};

export function profileCommitIdentity(profile: ProfileIdentity): CommitIdentity {
  return profile.authorName !== null && profile.authorName.trim() !== ""
    ? { email: profile.email, name: profile.authorName }
    : { email: profile.email };
}

/** Everything the commit footer and its popover show, in one round trip. */
export async function inspectCommitIdentity(
  git: GitExec,
  cwd: string,
  worktreeId: string,
  profile: ProfileIdentity,
  env: NodeJS.ProcessEnv = process.env
): Promise<CommitIdentityInspection> {
  const [pwrgit, outside, config, recent] = await Promise.all([
    predictPwrGitIdentity(git, cwd, profileCommitIdentity(profile)),
    resolveOutsideIdentity(git, cwd),
    readIdentityConfig(git, cwd),
    readRecentCommitIdentities(git, cwd)
  ]);
  return {
    worktreeId,
    profile,
    pwrgit,
    outside,
    config,
    env: identityEnvOverrides(env),
    recent,
    signing: signingFromConfig(config)
  };
}

/**
 * The file `git config --global` writes: `GIT_CONFIG_GLOBAL` when set, else
 * `~/.gitconfig` unless only the XDG file exists (git-config(1), FILES).
 */
export function globalConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string {
  const explicit = env["GIT_CONFIG_GLOBAL"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const home = env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : homedir();
  const dotfile = join(home, ".gitconfig");
  if (exists(dotfile)) return dotfile;
  const xdgHome = env["XDG_CONFIG_HOME"];
  const xdg = join(xdgHome !== undefined && xdgHome !== "" ? xdgHome : join(home, ".config"), "git", "config");
  return exists(xdg) ? xdg : dotfile;
}

/**
 * Git's identity with no repository in the way. Run from the temp root,
 * where no repository config or `includeIf "gitdir:…"` can apply.
 */
export async function resolveMachineIdentity(
  git: GitExec,
  cwd: string = tmpdir(),
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  outside: OutsideGitIdentity;
  config: IdentityConfigEntry[];
  globalFile: string;
}> {
  const [outside, config] = await Promise.all([
    resolveOutsideIdentity(git, cwd),
    readConfigEntries(git, cwd, MACHINE_KEYS)
  ]);
  return { outside, config, globalFile: globalConfigFile(env) };
}

/** Anything Git would store as a line break or misread as the `<…>` around
 *  an address. */
const UNSAFE_IDENTITY = /[\u0000-\u001f\u007f<>]/;

export function validateGlobalIdentity(
  name: string,
  email: string
): Result<{ name: string; email: string }> {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  if (trimmedName === "" || trimmedEmail === "") {
    return err({
      kind: "validation",
      code: "identity_incomplete",
      message: "Enter both a name and an email."
    });
  }
  if (UNSAFE_IDENTITY.test(trimmedName) || UNSAFE_IDENTITY.test(trimmedEmail)) {
    return err({
      kind: "validation",
      code: "identity_invalid",
      message: "Names and emails can’t contain line breaks or angle brackets."
    });
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmedEmail)) {
    return err({
      kind: "validation",
      code: "identity_invalid_email",
      message: "That doesn’t look like an email address."
    });
  }
  return ok({ name: trimmedName, email: trimmedEmail });
}

/** `git config --global user.name/user.email`. The only identity PwrGit ever
 *  writes, and only at an explicit click after a preview. */
export async function writeGlobalIdentity(
  git: GitExec,
  name: string,
  email: string,
  cwd: string = tmpdir()
): Promise<Result<null>> {
  const valid = validateGlobalIdentity(name, email);
  if (!valid.ok) return valid;
  for (const [key, value] of [
    ["user.name", valid.value.name],
    ["user.email", valid.value.email]
  ] as const) {
    const raw = await git(["config", "--global", key, value], cwd);
    if (!raw.ok) return raw;
    if (raw.value.exitCode !== 0) {
      return err({
        kind: "git",
        code: "config_write_failed",
        message: `Git couldn’t write ${key}: ${refusal(raw.value.stderr)}`,
        detail: raw.value.stderr.trim()
      });
    }
  }
  return ok(null);
}
