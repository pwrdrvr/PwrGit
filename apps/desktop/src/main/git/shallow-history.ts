import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  err,
  isShallowUnsupportedError,
  ok,
  parseHistoryDepth,
  HISTORY_DEPTH_HINT,
  type DeepenHistoryMode,
  type PwrGitError,
  type Result
} from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";

/**
 * Where a shallow repository's downloaded history ends, and where more of it
 * would come from.
 *
 * Read on every History load, so it costs one `rev-parse`, one file read and
 * (only when shallow) one `remote` and one `config` call — never a network
 * request and never a history walk. Linked worktrees share the common
 * directory's `shallow` file, so every checkout of a repository reads the same
 * boundary.
 */
export type ShallowState = {
  boundaries: Set<string>;
  remote: string | null;
  fetchesOnly: string[] | null;
};

/** The boundary commits, or null when the repository is complete. */
export async function readShallowBoundaries(
  git: GitExec,
  cwd: string
): Promise<Result<Set<string> | null>> {
  const args = ["rev-parse", "--is-shallow-repository", "--git-common-dir"];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const [answer, commonDir] = raw.value.stdout.split("\n").map((line) => line.trim());
  if (answer !== "true" || commonDir === undefined || commonDir === "") return ok(null);
  const dir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  // `rev-parse` said shallow, so an unreadable file is still a shallow
  // repository: report it with no drawable boundary rather than as complete.
  const text = await readFile(join(dir, "shallow"), "utf8").catch(() => "");
  return ok(
    new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line))
    )
  );
}

/**
 * The remote older history is fetched from: the one that publishes the default
 * branch (`origin/main` → `origin`), else `origin`, else the first configured
 * remote. Remote names may contain `/`, so the longest matching prefix wins.
 */
export function chooseHistoryRemote(
  remotes: readonly string[],
  defaultRef: string
): string | null {
  const owner = remotes
    .filter((name) => defaultRef.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (owner !== undefined) return owner;
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? null;
}

/**
 * The branches `remote.<name>.fetch` names, or null when it fetches every
 * branch. A clone made with `--depth` and without `--no-single-branch` has
 * `+refs/heads/main:refs/remotes/origin/main` here, and deepening it never
 * brings the other branches: History must not imply that they exist.
 */
export function fetchedBranches(refspecs: readonly string[]): string[] | null {
  const branches: string[] = [];
  for (const raw of refspecs) {
    const spec = raw.replace(/^\+/, "");
    if (spec.startsWith("^")) continue;
    const source = spec.split(":", 1)[0] ?? "";
    if (source === "refs/heads/*") return null;
    if (source.startsWith("refs/heads/")) branches.push(source.slice("refs/heads/".length));
  }
  return branches;
}

async function listRemotes(git: GitExec, cwd: string): Promise<Result<string[]>> {
  const raw = await git(["remote"], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["remote"]);
  if (!checked.ok) return checked;
  return ok(raw.value.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

/** Everything History needs about a shallow repository, or null for a
 *  complete one (the common case, which costs a single `rev-parse`). */
export async function readShallowState(
  git: GitExec,
  cwd: string,
  defaultRef: string
): Promise<Result<ShallowState | null>> {
  const boundaries = await readShallowBoundaries(git, cwd);
  if (!boundaries.ok) return boundaries;
  if (boundaries.value === null) return ok(null);
  const remotes = await listRemotes(git, cwd);
  if (!remotes.ok) return remotes;
  const remote = chooseHistoryRemote(remotes.value, defaultRef);
  let fetchesOnly: string[] | null = null;
  if (remote !== null) {
    const raw = await git(["config", "--get-all", `remote.${remote}.fetch`], cwd);
    // Exit 1 is "no such key": a remote with no fetch refspec fetches nothing
    // by default, which is the most limited answer, not the widest.
    if (raw.ok && (raw.value.exitCode === 0 || raw.value.exitCode === 1)) {
      fetchesOnly = fetchedBranches(
        raw.value.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
      );
    }
  }
  return ok({ boundaries: boundaries.value, remote, fetchesOnly });
}

/** The fetch that brings older history, or a validation error for a mode a
 *  caller could have sent with a count Git should never see. */
export function deepenArgs(
  remote: string,
  mode: DeepenHistoryMode
): Result<string[]> {
  if (mode.kind === "unshallow") {
    return ok(["fetch", "--progress", "--unshallow", "--", remote]);
  }
  if (mode.kind !== "deepen") {
    return err({ kind: "validation", code: "invalid_history_mode", message: "Choose how much history to fetch." });
  }
  const commits = typeof mode.commits === "number" ? parseHistoryDepth(mode.commits) : null;
  if (commits === null) {
    return err({ kind: "validation", code: "invalid_history_depth", message: HISTORY_DEPTH_HINT });
  }
  return ok(["fetch", "--progress", `--deepen=${commits}`, "--", remote]);
}

/** A server that cannot serve shallow requests, in words the user can act on. */
export function shallowUnsupportedError(subject: string, remedy: string): PwrGitError {
  return {
    kind: "remote",
    code: "shallow_unsupported",
    message: `${subject} can't serve a limited-history request: the server doesn't support shallow clones or fetches. ${remedy}`
  };
}

/**
 * Fetch older history from `remote`. The caller has checked the repository is
 * shallow; this checks the remote is configured (so a name can never reach
 * Git as an option) and that the count is one PwrGit would send.
 */
export async function deepenHistory(
  git: GitExec,
  cwd: string,
  remote: string,
  mode: DeepenHistoryMode
): Promise<Result<{ shallow: boolean }>> {
  const remotes = await listRemotes(git, cwd);
  if (!remotes.ok) return remotes;
  if (!remotes.value.includes(remote)) {
    return err({ kind: "remote", code: "remote_missing", message: `Remote "${remote}" no longer exists.` });
  }
  const args = deepenArgs(remote, mode);
  if (!args.ok) return args;
  const raw = await git(args.value, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0 && isShallowUnsupportedError(raw.value.stderr)) {
    return err(shallowUnsupportedError(remote, "Nothing was changed."));
  }
  const checked = requireExit0(raw.value, args.value);
  if (!checked.ok) return checked;
  const after = await readShallowBoundaries(git, cwd);
  if (!after.ok) return after;
  return ok({ shallow: after.value !== null });
}
