import {
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

/** Pull = fetch + fast-forward-only merge of the tracked upstream. */
export async function pullFastForward(
  git: GitExec,
  cwd: string
): Promise<Result<{ fastForwarded: boolean }>> {
  const fetched = await fetchRemote(git, cwd);
  if (!fetched.ok) return fetched;

  const merge = await git(["merge", "--ff-only", "@{u}"], cwd);
  if (!merge.ok) return merge;
  if (merge.value.exitCode !== 0) {
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
  return ok({ fastForwarded: true });
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
