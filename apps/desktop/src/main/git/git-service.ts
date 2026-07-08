import {
  type BranchRef,
  type ChangeSet,
  type Commit,
  err,
  type FileStatus,
  ok,
  type Result
} from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";

function mapStatusCode(c: string | undefined): FileStatus {
  switch (c) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "C":
      return "C";
    case "U":
      return "U";
    default:
      return "M";
  }
}

/**
 * Parse `git status --porcelain=v2`. Ordinary/renamed entries carry an index
 * (staged) code X and a worktree (unstaged) code Y; a file can appear in both.
 */
export function parseChanges(stdout: string): ChangeSet {
  const staged: ChangeSet["staged"] = [];
  const unstaged: ChangeSet["unstaged"] = [];

  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const kind = line[0];

    if (kind === "1" || kind === "2") {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const x = xy[0];
      const y = xy[1];
      const path =
        kind === "1"
          ? parts.slice(8).join(" ")
          : (parts.slice(9).join(" ").split("\t")[0] ?? "");
      if (path === "") continue;
      if (x !== "." && x !== undefined) {
        staged.push({ path, status: mapStatusCode(x), staged: true });
      }
      if (y !== "." && y !== undefined) {
        unstaged.push({ path, status: mapStatusCode(y), staged: false });
      }
    } else if (kind === "u") {
      const path = line.split(" ").slice(10).join(" ");
      if (path !== "") unstaged.push({ path, status: "U", staged: false });
    } else if (kind === "?") {
      const path = line.slice(2);
      if (path !== "") unstaged.push({ path, status: "?", staged: false });
    }
  }

  return { staged, unstaged };
}

/** Read the staged/unstaged change set for a worktree. */
export async function readChanges(
  git: GitExec,
  cwd: string
): Promise<Result<ChangeSet>> {
  const raw = await git(["status", "--porcelain=v2"], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["status"]);
  if (!checked.ok) return checked;
  return ok(parseChanges(checked.value.stdout));
}

export async function stagePath(
  git: GitExec,
  cwd: string,
  path: string
): Promise<Result<void>> {
  const raw = await git(["add", "--", path], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["add"]);
  return checked.ok ? ok(undefined) : checked;
}

export async function unstagePath(
  git: GitExec,
  cwd: string,
  path: string
): Promise<Result<void>> {
  const raw = await git(["restore", "--staged", "--", path], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["restore"]);
  return checked.ok ? ok(undefined) : checked;
}

/** Unified diff for one working-tree file. Untracked files (empty `git diff`)
 *  are rendered as a new-file diff via --no-index. */
export async function fileDiff(
  git: GitExec,
  cwd: string,
  path: string,
  staged: boolean
): Promise<Result<string>> {
  const args = staged
    ? ["diff", "--cached", "--no-color", "--", path]
    : ["diff", "--no-color", "--", path];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  if (staged || raw.value.stdout.trim() !== "") return ok(raw.value.stdout);
  // Unstaged but empty → likely untracked; synthesize a new-file diff.
  const nul = process.platform === "win32" ? "NUL" : "/dev/null";
  const untracked = await git(
    ["diff", "--no-color", "--no-index", "--", nul, path],
    cwd
  );
  // --no-index exits 1 when the files differ (the normal case here), so we take
  // stdout regardless of exit code.
  return untracked.ok ? ok(untracked.value.stdout) : ok(raw.value.stdout);
}

/** Unified diff of the changes a commit introduced (all files, renames detected). */
export async function commitDiff(
  git: GitExec,
  cwd: string,
  hash: string
): Promise<Result<string>> {
  const raw = await git(
    ["show", "--no-color", "--format=", "--patch", "-M", hash],
    cwd
  );
  if (!raw.ok) return raw;
  return ok(raw.value.stdout);
}

export type CommitIdentity = { name?: string; email: string };

/**
 * Commit staged changes under a per-commit identity override — PwrGit never
 * writes repo-local `user.email` (KTD4). Amend rewrites the last commit.
 */
export async function commitChanges(
  git: GitExec,
  cwd: string,
  message: string,
  identity: CommitIdentity,
  options: { amend?: boolean } = {}
): Promise<Result<void>> {
  const args = ["-c", `user.email=${identity.email}`];
  if (identity.name !== undefined && identity.name !== "") {
    args.push("-c", `user.name=${identity.name}`);
  }
  args.push("commit");
  if (options.amend === true) args.push("--amend");
  args.push("-m", message);

  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    const combined = `${raw.value.stdout}\n${raw.value.stderr}`;
    const code = /nothing to commit/i.test(combined)
      ? "nothing_to_commit"
      : "commit_failed";
    return err({
      kind: "git",
      code,
      message: raw.value.stderr.trim() || "commit failed"
    });
  }
  return ok(undefined);
}

const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%cI", "%s"].join("%x1f") + "%x1e";

/** Parse the delimited `git log` output produced with LOG_FORMAT. */
export function parseLog(stdout: string): Commit[] {
  return stdout
    .split("\x1e")
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((rec) => {
      const [hash = "", parents = "", an = "", ae = "", cI = "", subject = ""] =
        rec.split("\x1f");
      const parentList = parents.trim().split(/\s+/).filter((p) => p.length > 0);
      return {
        hash,
        shortHash: hash.slice(0, 7),
        parents: parentList,
        subject,
        authorName: an,
        authorEmail: ae,
        committedAt: cI,
        isMerge: parentList.length > 1
      };
    });
}

/** Read a page of commit history for a worktree (HEAD-first). */
export async function readLog(
  git: GitExec,
  cwd: string,
  limit: number
): Promise<Result<Commit[]>> {
  const raw = await git(
    ["log", `--pretty=format:${LOG_FORMAT}`, "-n", String(limit)],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["log"]);
  if (!checked.ok) return checked;
  return ok(parseLog(checked.value.stdout));
}

export type WorktreeInfo = {
  path: string;
  branch: string;
  head: string;
  detached: boolean;
  bare: boolean;
};

/**
 * Parse `git worktree list --porcelain` output. Blocks are separated by blank
 * lines; the first block is always the repo's primary worktree.
 */
export function parseWorktreeList(stdout: string): WorktreeInfo[] {
  const blocks = stdout
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const out: WorktreeInfo[] = [];
  for (const block of blocks) {
    let path = "";
    let head = "";
    let branch = "";
    let detached = false;
    let bare = false;

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9).trim();
      else if (line.startsWith("HEAD ")) head = line.slice(5).trim();
      else if (line.startsWith("branch "))
        branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
    }

    if (path === "") continue;
    if (branch === "") {
      branch = detached
        ? `detached@${head.slice(0, 7)}`
        : bare
          ? "(bare)"
          : "(unknown)";
    }
    out.push({ path, branch, head, detached, bare });
  }
  return out;
}

/** List a repository's worktrees (primary first). */
export async function listWorktrees(
  git: GitExec,
  repoPath: string
): Promise<Result<WorktreeInfo[]>> {
  const raw = await git(["worktree", "list", "--porcelain"], repoPath);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["worktree", "list"]);
  if (!checked.ok) return checked;
  return ok(parseWorktreeList(checked.value.stdout));
}

/** Create a worktree, optionally checking out a new branch. */
export async function worktreeAdd(
  git: GitExec,
  repoPath: string,
  worktreePath: string,
  branch: string,
  options: { newBranch: boolean }
): Promise<Result<void>> {
  const args = options.newBranch
    ? ["worktree", "add", "-b", branch, worktreePath]
    : ["worktree", "add", worktreePath, branch];
  const raw = await git(args, repoPath);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    const message = raw.value.stderr.trim();
    const code = /already exists|already checked out|already used/i.test(message)
      ? "already_exists"
      : "worktree_add_failed";
    return err({ kind: "repo", code, message: message || "worktree add failed" });
  }
  return ok(undefined);
}

/** Remove a worktree; refuses when it has changes unless forced. */
export async function worktreeRemove(
  git: GitExec,
  repoPath: string,
  worktreePath: string,
  options: { force: boolean } = { force: false }
): Promise<Result<void>> {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktreePath);
  const raw = await git(args, repoPath);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    const message = raw.value.stderr.trim();
    const code = /modified or untracked|contains modified|is dirty|use --force/i.test(
      message
    )
      ? "dirty"
      : /is a main working tree|main worktree/i.test(message)
        ? "is_primary"
        : "worktree_remove_failed";
    return err({
      kind: "repo",
      code,
      message: message || "worktree remove failed"
    });
  }
  return ok(undefined);
}

/** Fetch all remotes and prune deleted remote branches. */
export async function fetchRemote(
  git: GitExec,
  cwd: string
): Promise<Result<void>> {
  const raw = await git(["fetch", "--prune"], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["fetch"]);
  return checked.ok ? ok(undefined) : checked;
}

export type PullOutcome = {
  fastForwarded: boolean;
  /** Local work was stashed to let the fast-forward proceed. */
  stashed: boolean;
  /** Reapplying the stash after the pull hit conflicts (markers left in-tree). */
  reappliedWithConflicts: boolean;
};

/**
 * Pull = fetch + fast-forward-only merge of the tracked upstream. When the
 * working tree is dirty, local work (tracked + untracked) is auto-stashed so a
 * fast-forward that touches those files isn't blocked, then reapplied — the
 * GitHub-Desktop behavior. A conflicting reapply is reported, not hidden.
 */
export async function pullFastForward(
  git: GitExec,
  cwd: string
): Promise<Result<PullOutcome>> {
  const fetched = await fetchRemote(git, cwd);
  if (!fetched.ok) return fetched;

  const status = await git(["status", "--porcelain"], cwd);
  const dirty = status.ok && status.value.stdout.trim() !== "";

  let stashed = false;
  if (dirty) {
    const stash = await git(
      ["stash", "push", "--include-untracked", "-m", "pwrgit: auto-stash before pull"],
      cwd
    );
    if (!stash.ok) return stash;
    stashed =
      stash.value.exitCode === 0 &&
      !/no local changes to save/i.test(stash.value.stdout);
  }

  const restoreStash = async (): Promise<void> => {
    if (stashed) await git(["stash", "pop"], cwd);
  };

  const merge = await git(["merge", "--ff-only", "@{u}"], cwd);
  if (!merge.ok) {
    await restoreStash();
    return merge;
  }
  if (merge.value.exitCode !== 0) {
    await restoreStash();
    const message = merge.value.stderr.trim();
    const code = /fast-forward/i.test(message)
      ? "not_fast_forward"
      : /upstream|tracking/i.test(message)
        ? "no_upstream"
        : "merge_failed";
    return err({
      kind: "remote",
      code,
      message: message !== "" ? message : "pull could not fast-forward"
    });
  }

  if (!stashed) {
    return ok({ fastForwarded: true, stashed: false, reappliedWithConflicts: false });
  }
  // Reapply the stashed work. `git stash pop` leaves conflict markers (and keeps
  // the stash) when it can't apply cleanly — surface that so the user can resolve.
  const pop = await git(["stash", "pop"], cwd);
  if (!pop.ok) return pop;
  return ok({
    fastForwarded: true,
    stashed: true,
    reappliedWithConflicts: pop.value.exitCode !== 0
  });
}

/**
 * Discard a file's uncommitted changes. A file that exists in HEAD is reset
 * (index + worktree) back to HEAD; a new file (untracked, or staged-add) is
 * unstaged and removed. Destructive — callers confirm first.
 */
export async function discardPath(
  git: GitExec,
  cwd: string,
  path: string
): Promise<Result<void>> {
  const inHead = await git(["cat-file", "-e", `HEAD:${path}`], cwd);
  if (inHead.ok && inHead.value.exitCode === 0) {
    const raw = await git(
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", path],
      cwd
    );
    if (!raw.ok) return raw;
    const checked = requireExit0(raw.value, ["restore"]);
    return checked.ok ? ok(undefined) : checked;
  }
  // New file: best-effort unstage (a no-op/expected error for untracked), then
  // remove it from the working tree.
  await git(["restore", "--staged", "--", path], cwd);
  const clean = await git(["clean", "-fd", "--", path], cwd);
  if (!clean.ok) return clean;
  const checked = requireExit0(clean.value, ["clean"]);
  return checked.ok ? ok(undefined) : checked;
}

// Tab-delimited so subjects (last field) can contain anything but a tab.
const BRANCH_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(HEAD)",
  "%(upstream:short)",
  "%(committerdate:iso8601-strict)",
  "%(contents:subject)"
].join("%09");

/** Parse the tab-delimited `git for-each-ref` output produced with BRANCH_FORMAT. */
export function parseBranchRefs(stdout: string): BranchRef[] {
  const out: BranchRef[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [full = "", name = "", head = "", upstream = "", date = "", subject = ""] =
      line.split("\t");
    if (full === "" || name === "") continue;
    const isRemote = full.startsWith("refs/remotes/");
    // Skip a remote's symbolic HEAD pointer (e.g. origin/HEAD -> origin/main).
    if (isRemote && name.endsWith("/HEAD")) continue;
    const ref: BranchRef = { name, isRemote, isCurrent: head === "*" };
    if (upstream !== "") ref.upstream = upstream;
    if (date !== "") ref.lastCommitAt = date;
    if (subject !== "") ref.subject = subject;
    out.push(ref);
  }
  return out;
}

/**
 * List a worktree's switchable branches — local heads and remote-tracking refs,
 * most-recently-committed first. `%(HEAD)` marks the branch checked out in the
 * worktree the command runs in (so it's correct per-worktree, not per-repo).
 */
export async function listBranches(
  git: GitExec,
  cwd: string
): Promise<Result<BranchRef[]>> {
  const raw = await git(
    [
      "for-each-ref",
      "--sort=-committerdate",
      `--format=${BRANCH_FORMAT}`,
      "refs/heads",
      "refs/remotes"
    ],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;
  return ok(parseBranchRefs(checked.value.stdout));
}

/**
 * Check out `branch` in this worktree. `git switch` DWIMs a bare remote name
 * (e.g. "main" when only origin/main exists) into a new tracking branch, so
 * callers pass the short local name even for remote-only branches.
 */
export async function switchBranch(
  git: GitExec,
  cwd: string,
  branch: string
): Promise<Result<void>> {
  const raw = await git(["switch", branch], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    const message = raw.value.stderr.trim();
    const code = /already used by worktree|already checked out/i.test(message)
      ? "checked_out_elsewhere"
      : /overwritten by checkout|local changes|would be overwritten/i.test(message)
        ? "dirty"
        : "switch_failed";
    return err({
      kind: "repo",
      code,
      message: message !== "" ? message : "Could not switch branch"
    });
  }
  return ok(undefined);
}

/** Push the current branch to its upstream. */
export async function pushRemote(
  git: GitExec,
  cwd: string
): Promise<Result<void>> {
  const raw = await git(["push"], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    const message = raw.value.stderr.trim();
    const code = /non-fast-forward|rejected/i.test(message)
      ? "rejected"
      : /no upstream|has no upstream/i.test(message)
        ? "no_upstream"
        : "push_failed";
    return err({
      kind: "remote",
      code,
      message: message !== "" ? message : "push failed"
    });
  }
  return ok(undefined);
}
