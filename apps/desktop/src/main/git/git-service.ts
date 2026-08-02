import { rmSync } from "node:fs";
import {
  type BranchRef,
  type ChangeSet,
  type Commit,
  type CommitFileChange,
  type CommitStats,
  type DivergenceCommit,
  type RemoteDivergence,
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

/** Parse `--name-status` output ("M\tpath", "R100\told\tnew", …). Renames and
 *  copies report the NEW path. */
export function parseNameStatus(stdout: string): CommitFileChange[] {
  const out: CommitFileChange[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0];
    if (code === undefined) continue;
    const path = (parts.length > 2 ? parts[2] : parts[1]) ?? "";
    if (path === "") continue;
    out.push({ path, status: mapStatusCode(code) });
  }
  return out;
}

/** The files a commit touched, with status letters. */
export async function commitFiles(
  git: GitExec,
  cwd: string,
  hash: string
): Promise<Result<CommitFileChange[]>> {
  const raw = await git(
    ["show", "--name-status", "--format=", "-M", hash],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["show"]);
  if (!checked.ok) return checked;
  return ok(parseNameStatus(checked.value.stdout));
}

/** Sum Git's tab-delimited numstat output. Binary entries are represented by
 * dashes and deliberately contribute neither additions nor deletions. */
export function parseNumstat(stdout: string): CommitStats {
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const [added = "", removed = ""] = line.split("\t", 3);
    const addedCount = Number.parseInt(added, 10);
    const removedCount = Number.parseInt(removed, 10);
    if (Number.isFinite(addedCount)) additions += addedCount;
    if (Number.isFinite(removedCount)) deletions += removedCount;
  }
  return { additions, deletions };
}

/** Diffstat for one commit. Merge commits use their first parent, the same
 * comparison that makes a single-commit diff useful in the UI. */
export async function commitStats(
  git: GitExec,
  cwd: string,
  hash: string
): Promise<Result<CommitStats>> {
  const raw = await git(
    ["show", "--format=", "--numstat", "--diff-merges=first-parent", hash],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["show"]);
  if (!checked.ok) return checked;
  return ok(parseNumstat(checked.value.stdout));
}

/** Unified diff of ONE file within a commit. */
export async function commitFileDiff(
  git: GitExec,
  cwd: string,
  hash: string,
  path: string
): Promise<Result<string>> {
  const raw = await git(
    ["show", "--no-color", "--format=", "--patch", "-M", hash, "--", path],
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

/** Read a topo-ordered union log across several refs (for the multi-lane graph). */
export async function readLogRefs(
  git: GitExec,
  cwd: string,
  refs: string[],
  limit: number
): Promise<Result<Commit[]>> {
  if (refs.length === 0) return ok([]);
  const raw = await git(
    [
      "log",
      "--topo-order",
      `--pretty=format:${LOG_FORMAT}`,
      "-n",
      String(limit),
      ...refs,
      "--"
    ],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["log"]);
  if (!checked.ok) return checked;
  return ok(parseLog(checked.value.stdout));
}

/**
 * The union of commits reachable from `refs` but NOT from `notRef`, in one
 * walk. This is how branch segments are fetched for the graph: a flat
 * `git log refs -n N` gets flooded by a busy trunk (newest N commits are all
 * trunk), silently dropping branch tips — fetching only the not-in-trunk
 * commits guarantees every branch's work is present no matter how noisy the
 * default branch is.
 */
export async function readUniqueCommits(
  git: GitExec,
  cwd: string,
  notRef: string,
  refs: string[],
  limit: number
): Promise<Result<Commit[]>> {
  if (refs.length === 0) return ok([]);
  const raw = await git(
    [
      "log",
      "--topo-order",
      `--pretty=format:${LOG_FORMAT}`,
      "-n",
      String(limit),
      ...refs,
      "--not",
      notRef,
      "--"
    ],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["log"]);
  if (!checked.ok) return checked;
  return ok(parseLog(checked.value.stdout));
}

/**
 * Merge separately-fetched commit groups (trunk window + branch segments) into
 * one children-before-parents order, newest-first among the ready set — the
 * order the lane layout expects. Kahn's algorithm over the sub-DAG; parents
 * outside the set are simply absent (the layout draws them as trailing stubs).
 */
export function topoMergeCommits(groups: Commit[][]): Commit[] {
  const byHash = new Map<string, Commit>();
  for (const group of groups) {
    for (const c of group) if (!byHash.has(c.hash)) byHash.set(c.hash, c);
  }
  const childCount = new Map<string, number>();
  for (const c of byHash.values()) {
    for (const p of c.parents) {
      if (byHash.has(p)) childCount.set(p, (childCount.get(p) ?? 0) + 1);
    }
  }
  const at = (c: Commit): number => new Date(c.committedAt).getTime();
  const ready: Commit[] = [];
  for (const c of byHash.values()) {
    if ((childCount.get(c.hash) ?? 0) === 0) ready.push(c);
  }
  const out: Commit[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => at(b) - at(a));
    const c = ready.shift();
    if (c === undefined) break;
    out.push(c);
    for (const p of c.parents) {
      const parent = byHash.get(p);
      if (parent === undefined) continue;
      const n = (childCount.get(p) ?? 0) - 1;
      childCount.set(p, n);
      if (n === 0) ready.push(parent);
    }
  }
  return out;
}

/**
 * Branches to draw in "all" scope: everything still in flight — local heads
 * AND remote-tracking branches not merged into the default branch, most
 * recently committed first, capped. Remote branches shadowed by a same-named
 * local are dropped (the local lane covers them). This is the "is anybody
 * else working on something here?" view.
 */
export async function selectAllGraphBranches(
  git: GitExec,
  cwd: string,
  defaultRef: string,
  defaultName: string,
  cap = 40
): Promise<Result<{ branches: string[]; total: number }>> {
  const raw = await git(
    [
      "for-each-ref",
      "--sort=-committerdate",
      `--count=${cap * 3}`,
      `--no-merged=${defaultRef}`,
      "--format=%(refname)%09%(refname:short)",
      "refs/heads",
      "refs/remotes"
    ],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;

  type Entry = { short: string; remote: boolean };
  const entries: Entry[] = [];
  const locals = new Set<string>();
  for (const line of checked.value.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [full = "", short = ""] = line.split("\t");
    if (full === "" || short === "") continue;
    if (full.startsWith("refs/heads/")) {
      entries.push({ short, remote: false });
      locals.add(short);
    } else if (!short.endsWith("/HEAD")) {
      entries.push({ short, remote: true });
    }
  }

  const qualified: string[] = [];
  for (const e of entries) {
    if (!e.remote) {
      if (e.short !== defaultName) qualified.push(e.short);
      continue;
    }
    const tail = e.short.replace(/^[^/]+\//, "");
    if (tail === defaultName || e.short === defaultRef) continue;
    if (locals.has(tail)) continue;
    qualified.push(e.short);
  }
  return ok({ branches: qualified.slice(0, cap), total: qualified.length });
}

/** Short names of all local branches, most recently committed first. */
export async function listLocalBranchNames(
  git: GitExec,
  cwd: string
): Promise<Result<string[]>> {
  const raw = await git(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads"
    ],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;
  return ok(
    checked.value.stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "")
  );
}

/** Branch tips for graph ref labels, split by where the ref lives. */
export type BranchTips = {
  /** commit hash → local branch names tipped there. */
  local: Record<string, string[]>;
  /** commit hash → remote-tracking refs tipped there (e.g. "origin/main").
   *  Remote HEAD aliases (refs/remotes/&ast;/HEAD) are excluded — the graph
   *  labels concrete branches, not symrefs. */
  remote: Record<string, string[]>;
};

export async function branchTips(
  git: GitExec,
  cwd: string
): Promise<Result<BranchTips>> {
  const raw = await git(
    [
      "for-each-ref",
      "--format=%(objectname)%09%(refname)%09%(refname:short)",
      "refs/heads",
      "refs/remotes"
    ],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;

  const local: Record<string, string[]> = {};
  const remote: Record<string, string[]> = {};
  for (const line of checked.value.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [hash = "", full = "", name = ""] = line.split("\t");
    if (hash === "" || name === "") continue;
    if (full.startsWith("refs/heads/")) {
      (local[hash] ??= []).push(name);
    } else if (full.startsWith("refs/remotes/") && !full.endsWith("/HEAD")) {
      (remote[hash] ??= []).push(name);
    }
  }
  return ok({ local, remote });
}

/**
 * Which of `branches` contain a commit (not in the default branch) authored or
 * co-authored by `email` — computed in ONE `git log` across all of them via
 * `--source` (%S), rather than one process per branch.
 */
async function branchesIAuthored(
  git: GitExec,
  cwd: string,
  defaultRef: string,
  branches: string[],
  email: string
): Promise<Set<string>> {
  const mine = new Set<string>();
  if (email === "" || branches.length === 0) return mine;
  const fmt =
    "%S%x00%ae%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f)";
  const raw = await git(
    ["log", "--source", "--no-patch", `--format=${fmt}`, ...branches, "--not", defaultRef],
    cwd
  );
  if (!raw.ok || raw.value.exitCode !== 0) return mine;
  for (const line of raw.value.stdout.split("\n")) {
    if (line === "") continue;
    const [src = "", authorEmail = "", coauthors = ""] = line.split("\x00");
    if (src === "") continue;
    if (
      authorEmail.toLowerCase() === email ||
      coauthors.toLowerCase().includes(email)
    ) {
      mine.add(src);
    }
  }
  return mine;
}

export type ActiveBranchInput = {
  /** e.g. "origin/develop" or "main". */
  defaultRef: string;
  defaultName: string;
  /** Active profile's commit email (authored/co-authored ⇒ "mine"). */
  email: string;
  /** Branches checked out in a local worktree (always count as "mine"). */
  worktreeBranches: Set<string>;
  /** Branches with a merged PR — hidden even if not ancestry-merged (squash). */
  mergedPrBranches: Set<string>;
};

/**
 * The quiet default set: local branches with work not in the default branch
 * (ancestry-unmerged), that are "mine" (authored/co-authored a commit, or
 * checked out in a worktree), and not already merged via PR. This is what keeps
 * the lineage from becoming "everything that ever happened".
 */
export async function selectActiveBranches(
  git: GitExec,
  cwd: string,
  input: ActiveBranchInput
): Promise<Result<string[]>> {
  const raw = await git(
    [
      "for-each-ref",
      "--format=%(refname:short)",
      `--no-merged=${input.defaultRef}`,
      "refs/heads"
    ],
    cwd
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;

  const candidates = checked.value.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(
      (s) =>
        s !== "" && s !== input.defaultName && !input.mergedPrBranches.has(s)
    );

  // Worktree branches are "mine" outright; the rest need an authorship check,
  // batched into a single git log.
  const worktreeMine: string[] = [];
  const others: string[] = [];
  for (const b of candidates) {
    (input.worktreeBranches.has(b) ? worktreeMine : others).push(b);
  }
  const authored = await branchesIAuthored(
    git,
    cwd,
    input.defaultRef,
    others,
    input.email.toLowerCase()
  );
  return ok([...worktreeMine, ...others.filter((b) => authored.has(b))]);
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
  // Windows transiently locks files another process just touched — antivirus
  // scanning fresh files, or our own state probes: selecting a worktree row
  // fires WorktreeStateService.compute, a chain of several git spawns whose
  // cwd is the worktree, and a directory that is any process's cwd cannot be
  // deleted on Windows. A cold runner can stretch that chain to a few
  // seconds, so the retry budget must comfortably outlast it (~4.5s here,
  // plus the rmSync fallback's own retries below) while staying bounded so a
  // genuinely stuck handle still surfaces.
  const maxAttempts = 6;
  for (let attempt = 1; ; attempt += 1) {
    const raw = await git(args, repoPath);
    if (!raw.ok) return raw;
    if (raw.value.exitCode === 0) return ok(undefined);
    const message = raw.value.stderr.trim();
    // A retry can find the worktree already unregistered: the failed attempt
    // pruned git's metadata before the file deletion hit the lock. Finish the
    // delete ourselves (rmSync retries EPERM/EBUSY on Windows).
    if (attempt > 1 && /is not a working tree/i.test(message)) {
      try {
        rmSync(worktreePath, {
          recursive: true,
          force: true,
          maxRetries: 15,
          retryDelay: 300
        });
        return ok(undefined);
      } catch (cause) {
        return err({
          kind: "repo",
          code: "worktree_remove_failed",
          message: `left-over worktree directory could not be deleted: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        });
      }
    }
    const transient = /permission denied|device or resource busy|ebusy|eperm/i.test(
      message
    );
    if (transient && attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      continue;
    }
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

type UpstreamRef = {
  name: string;
  head: string;
};

type CheckedOutRef = {
  branch: string;
  head: string;
};

type RecoverySnapshot = Pick<
  RemoteDivergence,
  "branch" | "head" | "upstreamHead"
>;

const DIVERGENCE_LOG_FORMAT = "%H%x1f%s%x1e";

function parseDivergenceCommits(stdout: string): DivergenceCommit[] {
  return stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record) => {
      const [hash = "", subject = ""] = record.split("\x1f");
      return { shortHash: hash.slice(0, 7), subject };
    })
    .filter((commit) => commit.shortHash !== "");
}

async function resolveUpstream(
  git: GitExec,
  cwd: string
): Promise<Result<UpstreamRef>> {
  const nameRaw = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd
  );
  if (!nameRaw.ok) return nameRaw;
  if (nameRaw.value.exitCode !== 0) {
    return err({
      kind: "remote",
      code: "no_upstream",
      message: "This branch has no configured upstream."
    });
  }
  const name = nameRaw.value.stdout.trim();
  if (name === "") {
    return err({
      kind: "remote",
      code: "no_upstream",
      message: "This branch has no configured upstream."
    });
  }

  const headRaw = await git(["rev-parse", "--verify", "@{u}"], cwd);
  if (!headRaw.ok) return headRaw;
  if (headRaw.value.exitCode !== 0) {
    return err({
      kind: "remote",
      code: "no_upstream",
      message: "The configured upstream could not be resolved."
    });
  }
  const head = headRaw.value.stdout.trim();
  if (head === "") {
    return err({
      kind: "remote",
      code: "no_upstream",
      message: "The configured upstream could not be resolved."
    });
  }
  return ok({ name, head });
}

async function resolveCheckedOutRef(
  git: GitExec,
  cwd: string
): Promise<Result<CheckedOutRef>> {
  const branchRaw = await git(["branch", "--show-current"], cwd);
  if (!branchRaw.ok) return branchRaw;
  const branch = requireExit0(branchRaw.value, ["branch", "--show-current"]);
  if (!branch.ok) return branch;
  const name = branch.value.stdout.trim();
  if (name === "") {
    return err({
      kind: "remote",
      code: "detached_head",
      message: "This worktree is detached from a local branch."
    });
  }

  const headRaw = await git(["rev-parse", "--verify", "HEAD"], cwd);
  if (!headRaw.ok) return headRaw;
  const verifiedHead = requireExit0(headRaw.value, [
    "rev-parse",
    "--verify",
    "HEAD"
  ]);
  if (!verifiedHead.ok) return verifiedHead;
  const head = verifiedHead.value.stdout.trim();
  if (head === "") {
    return err({
      kind: "remote",
      code: "no_head",
      message: "This worktree has no checked-out commit."
    });
  }
  return ok({ branch: name, head });
}

async function requireCleanWorktree(
  git: GitExec,
  cwd: string
): Promise<Result<void>> {
  const statusRaw = await git(["status", "--porcelain"], cwd);
  if (!statusRaw.ok) return statusRaw;
  const status = requireExit0(statusRaw.value, ["status"]);
  if (!status.ok) return status;
  if (status.value.stdout.trim() !== "") {
    return err({
      kind: "remote",
      code: "dirty",
      message:
        "Your working tree has uncommitted changes. Commit, stash, or discard them before choosing a recovery action."
    });
  }
  return ok(undefined);
}

/**
 * Compare the current branch against its fetched upstream after a
 * non-fast-forward pull. Commit subjects are compared only as a signal for
 * the UI; object identity remains authoritative.
 */
export async function inspectRemoteDivergence(
  git: GitExec,
  cwd: string
): Promise<Result<RemoteDivergence>> {
  const checkout = await resolveCheckedOutRef(git, cwd);
  if (!checkout.ok) return checkout;
  const upstream = await resolveUpstream(git, cwd);
  if (!upstream.ok) return upstream;

  const [statusRaw, localRaw, upstreamRaw] = await Promise.all([
    git(["status", "--porcelain"], cwd),
    git(["log", `--pretty=format:${DIVERGENCE_LOG_FORMAT}`, "@{u}..HEAD"], cwd),
    git(["log", `--pretty=format:${DIVERGENCE_LOG_FORMAT}`, "HEAD..@{u}"], cwd)
  ]);
  if (!statusRaw.ok) return statusRaw;
  if (!localRaw.ok) return localRaw;
  if (!upstreamRaw.ok) return upstreamRaw;
  const status = requireExit0(statusRaw.value, ["status"]);
  if (!status.ok) return status;
  const local = requireExit0(localRaw.value, ["log"]);
  if (!local.ok) return local;
  const remote = requireExit0(upstreamRaw.value, ["log"]);
  if (!remote.ok) return remote;

  const localCommits = parseDivergenceCommits(local.value.stdout);
  const upstreamCommits = parseDivergenceCommits(remote.value.stdout);
  const matchingCommitSubjects =
    localCommits.length > 0 &&
    localCommits.length === upstreamCommits.length &&
    localCommits.every(
      (commit, index) => commit.subject === upstreamCommits[index]?.subject
    );

  return ok({
    branch: checkout.value.branch,
    head: checkout.value.head,
    upstream: upstream.value.name,
    upstreamHead: upstream.value.head,
    workingTreeClean: status.value.stdout.trim() === "",
    localCommits,
    upstreamCommits,
    matchingCommitSubjects
  });
}

async function checkedRecoveryUpstream(
  git: GitExec,
  cwd: string,
  expected: RecoverySnapshot
): Promise<Result<UpstreamRef>> {
  const checkout = await resolveCheckedOutRef(git, cwd);
  if (!checkout.ok) return checkout;
  if (
    checkout.value.branch !== expected.branch ||
    checkout.value.head !== expected.head
  ) {
    return err({
      kind: "remote",
      code: "checkout_changed",
      message:
        "The checked-out branch or commit changed while this comparison was open. Pull again to review the current history."
    });
  }
  const clean = await requireCleanWorktree(git, cwd);
  if (!clean.ok) return clean;
  const upstream = await resolveUpstream(git, cwd);
  if (!upstream.ok) return upstream;
  if (upstream.value.head !== expected.upstreamHead) {
    return err({
      kind: "remote",
      code: "upstream_changed",
      message:
        "The upstream changed while this comparison was open. Pull again to review the latest history."
    });
  }
  return upstream;
}

/** Reset a clean branch to the exact upstream commit the user reviewed. */
export async function resetToUpstream(
  git: GitExec,
  cwd: string,
  expected: RecoverySnapshot
): Promise<Result<void>> {
  const upstream = await checkedRecoveryUpstream(git, cwd, expected);
  if (!upstream.ok) return upstream;
  const raw = await git(["reset", "--hard", upstream.value.head], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(undefined);
  return err({
    kind: "remote",
    code: "reset_failed",
    message: "Could not reset the local branch to its upstream."
  });
}

/** Replay clean local-only commits on the exact upstream commit reviewed. */
export async function rebaseOntoUpstream(
  git: GitExec,
  cwd: string,
  expected: RecoverySnapshot
): Promise<Result<void>> {
  const upstream = await checkedRecoveryUpstream(git, cwd, expected);
  if (!upstream.ok) return upstream;
  const raw = await git(["rebase", upstream.value.head], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(undefined);
  const message = `${raw.value.stdout}\n${raw.value.stderr}`;
  const conflicted = /conflict|resolve all conflicts|could not apply/i.test(message);
  return err({
    kind: "remote",
    code: conflicted ? "rebase_conflict" : "rebase_failed",
    message: conflicted
      ? "Rebase stopped on a conflict. Resolve it, then continue or abort the rebase from a terminal."
      : "Could not rebase the local commits onto the upstream branch."
  });
}

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
    const message = `${merge.value.stderr}\n${merge.value.stdout}`.trim();
    const code = /fast-forward|diverg(?:e|ing)/i.test(message)
      ? "not_fast_forward"
      : /upstream|tracking/i.test(message)
        ? "no_upstream"
        : "merge_failed";
    return err({
      kind: "remote",
      code,
      message:
        code === "not_fast_forward"
          ? "Your local branch and its upstream have diverged."
          : message !== ""
            ? message
            : "pull could not fast-forward"
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
