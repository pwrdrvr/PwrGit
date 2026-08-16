import { rmSync } from "node:fs";
import {
  type BranchRef,
  type BranchTrackingStatus,
  type ChangeSet,
  type Commit,
  type CommitFileChange,
  type CommitStats,
  type DivergenceCommitAlignment,
  type DivergenceCommit,
  type LocalBranchSummary,
  type PushRefPlan,
  type PushRefResult,
  type PullProgressPhase,
  type PwrGitError,
  type RemoteDivergence,
  type RemoteResetMode,
  type RemoteResetSnapshot,
  type RemoteSummary,
  type RepoRefs,
  err,
  type FileStatus,
  ok,
  type Result
} from "@pwrgit/shared";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";

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
  const raw = await git(
    ["status", "--porcelain=v2"],
    cwd,
    NO_OPTIONAL_LOCKS
  );
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

/** Resolve one full or abbreviated SHA without walking the visible graph. */
export async function readCommit(
  git: GitExec,
  cwd: string,
  hash: string
): Promise<Result<Commit | null>> {
  const candidate = hash.trim();
  // Besides avoiding revision-option injection, this keeps ordinary palette
  // text from spawning Git probes. Four characters is Git's practical floor
  // for an abbreviated object ID; SHA-1 and SHA-256 repositories are covered.
  if (!/^[0-9a-f]{4,64}$/i.test(candidate)) return ok(null);

  const raw = await git(
    [
      "show",
      "--no-patch",
      `--pretty=format:${LOG_FORMAT}`,
      `${candidate}^{commit}`
    ],
    cwd
  );
  if (!raw.ok) return raw;
  // Missing and ambiguous abbreviations are normal search misses.
  if (raw.value.exitCode !== 0) return ok(null);
  const commit = parseLog(raw.value.stdout)[0];
  // Git's revision parser prefers an exact all-hex ref name over interpreting
  // it as an object-ID prefix. Reject that ref resolution unless its target is
  // also genuinely identified by the entered SHA.
  if (
    commit === undefined ||
    !commit.hash.toLowerCase().startsWith(candidate.toLowerCase())
  ) {
    return ok(null);
  }
  return ok(commit);
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
  options: { newBranch: boolean; startPoint?: string }
): Promise<Result<void>> {
  const args = options.newBranch
    ? [
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        ...(options.startPoint === undefined ? [] : [options.startPoint])
      ]
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

/** Fetch the checked-out branch's configured remote (or origin) and prune. */
export async function fetchRemote(
  git: GitExec,
  cwd: string,
  forceProgress = false
): Promise<Result<void>> {
  const args = ["fetch", "--prune", ...(forceProgress ? ["--progress"] : [])];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["fetch"]);
  return checked.ok ? ok(undefined) : checked;
}

/** Fetch one explicit remote and prune its deleted remote-tracking branches. */
export async function fetchNamedRemote(
  git: GitExec,
  cwd: string,
  remote: string
): Promise<Result<void>> {
  const raw = await git(["fetch", "--prune", remote], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["fetch", "--prune", remote]);
  return checked.ok ? ok(undefined) : checked;
}

/** Fetch every configured remote except those opted out with skipFetchAll. */
export async function fetchAllRemotes(
  git: GitExec,
  cwd: string
): Promise<Result<void>> {
  const raw = await git(["fetch", "--all", "--prune"], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["fetch", "--all", "--prune"]);
  return checked.ok ? ok(undefined) : checked;
}

async function checkedRemoteMutation(
  git: GitExec,
  cwd: string,
  args: string[],
  fallback: string
): Promise<Result<void>> {
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(undefined);
  return err({
    kind: "remote",
    code: "remote_config_failed",
    message: raw.value.stderr.trim() || fallback
  });
}

async function setRemotePushUrl(
  git: GitExec,
  cwd: string,
  name: string,
  pushUrl: string | undefined
): Promise<Result<void>> {
  if (pushUrl === undefined || pushUrl.trim() === "") {
    const raw = await git(["config", "--unset-all", `remote.${name}.pushurl`], cwd);
    if (!raw.ok) return raw;
    // Exit 5 means there was no explicit push URL, which is already desired.
    if (raw.value.exitCode === 0 || raw.value.exitCode === 5) return ok(undefined);
    return err({
      kind: "remote",
      code: "remote_config_failed",
      message: raw.value.stderr.trim() || "Could not clear the remote push URL."
    });
  }
  return checkedRemoteMutation(
    git,
    cwd,
    ["config", "--replace-all", `remote.${name}.pushurl`, pushUrl.trim()],
    "Could not set the remote push URL."
  );
}

export async function addRemote(
  git: GitExec,
  cwd: string,
  input: { name: string; fetchUrl: string; pushUrl?: string }
): Promise<Result<void>> {
  const added = await checkedRemoteMutation(
    git,
    cwd,
    ["remote", "add", input.name.trim(), input.fetchUrl.trim()],
    "Could not add the remote."
  );
  if (!added.ok) return added;
  return setRemotePushUrl(git, cwd, input.name.trim(), input.pushUrl);
}

export async function updateRemote(
  git: GitExec,
  cwd: string,
  input: {
    originalName: string;
    name: string;
    fetchUrl: string;
    pushUrl?: string;
  }
): Promise<Result<void>> {
  const originalName = input.originalName.trim();
  const name = input.name.trim();
  if (originalName !== name) {
    const renamed = await checkedRemoteMutation(
      git,
      cwd,
      ["remote", "rename", originalName, name],
      "Could not rename the remote."
    );
    if (!renamed.ok) return renamed;
  }
  const updated = await checkedRemoteMutation(
    git,
    cwd,
    ["remote", "set-url", name, input.fetchUrl.trim()],
    "Could not update the remote URL."
  );
  if (!updated.ok) return updated;
  return setRemotePushUrl(git, cwd, name, input.pushUrl);
}

export async function removeRemote(
  git: GitExec,
  cwd: string,
  remote: string
): Promise<Result<void>> {
  return checkedRemoteMutation(
    git,
    cwd,
    ["remote", "remove", remote],
    "Could not remove the remote."
  );
}

export type PullOutcome = {
  fastForwarded: boolean;
  /** Local work was stashed to let the fast-forward proceed. */
  stashed: boolean;
  /** Reapplying the stash after the pull hit conflicts (markers left in-tree). */
  reappliedWithConflicts: boolean;
};

export type PullExecutionControl = {
  signal?: AbortSignal;
  onActivity?: () => void;
  startRecovery?: () => PullRecoveryControl;
};

export type PullRecoveryControl = PullExecutionControl & {
  finish?: (succeeded: boolean) => void;
};

function controlledGit(git: GitExec, control: PullExecutionControl): GitExec {
  return (args, path, options) =>
    git(args, path, {
      ...options,
      ...(control.signal !== undefined ? { signal: control.signal } : {}),
      // A pull is force-stopped only after the generous watchdog limits. The
      // direct Git process receives SIGKILL; LFS/filter children normally exit
      // when Git and their inherited pipes close.
      ...(control.signal !== undefined ? { killSignal: "SIGKILL" } : {}),
      onActivity: () => {
        options?.onActivity?.();
        control.onActivity?.();
      }
    });
}

function isPullTimeout(error: PwrGitError): boolean {
  return error.code === "pull_stalled" || error.code === "pull_timed_out";
}

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

const DIVERGENCE_LOG_FORMAT = "%x1e%H%x1f%s";
const RANGE_DIFF_HEADER =
  /^\s*(?:\d+|-):\s+([0-9a-f]{40}|-{40})\s+([=!<>])\s+(?:\d+|-):\s+([0-9a-f]{40}|-{40})(?:\s|$)/;

function parseDivergenceCommits(stdout: string): DivergenceCommit[] {
  return stdout
    .split("\x1e")
    .map((record) => record.trimEnd())
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [header = "", ...stats] = record.trimStart().split(/\r?\n/);
      const [hash = "", subject = ""] = header.split("\x1f");
      let additions = 0;
      let deletions = 0;
      for (const line of stats) {
        const [added, deleted] = line.split("\t");
        if (/^\d+$/.test(added ?? "")) additions += Number(added);
        if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
      }
      return {
        hash,
        shortHash: hash.slice(0, 7),
        subject,
        additions,
        deletions
      };
    })
    .filter((commit) => commit.shortHash !== "");
}

function parseRangeDiff(
  stdout: string,
  localCommits: DivergenceCommit[],
  upstreamCommits: DivergenceCommit[]
): DivergenceCommitAlignment[] {
  const localByHash = new Map(localCommits.map((commit) => [commit.hash, commit]));
  const upstreamByHash = new Map(
    upstreamCommits.map((commit) => [commit.hash, commit])
  );
  const rows: DivergenceCommitAlignment[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const match = RANGE_DIFF_HEADER.exec(line);
    if (match === null) continue;
    const [, localHash = "", marker = "", upstreamHash = ""] = match;
    const local = localByHash.get(localHash) ?? null;
    const upstream = upstreamByHash.get(upstreamHash) ?? null;
    const relation =
      marker === "="
        ? "equivalent"
        : marker === "!"
          ? "changed"
          : marker === "<"
            ? "local-only"
            : "upstream-only";
    rows.push({ local, upstream, relation });
  }

  // range-diff is oldest-first; the recovery dialog presents branch tips first.
  return rows.reverse();
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

  const [statusRaw, localRaw, upstreamRaw, rangeDiffRaw] = await Promise.all([
    git(["status", "--porcelain"], cwd),
    git(
      ["log", "--numstat", `--format=${DIVERGENCE_LOG_FORMAT}`, "@{u}..HEAD"],
      cwd
    ),
    git(
      ["log", "--numstat", `--format=${DIVERGENCE_LOG_FORMAT}`, "HEAD..@{u}"],
      cwd
    ),
    git(
      [
        "range-diff",
        "--no-color",
        "--no-dual-color",
        "--abbrev=40",
        "HEAD...@{u}"
      ],
      cwd
    )
  ]);
  if (!statusRaw.ok) return statusRaw;
  if (!localRaw.ok) return localRaw;
  if (!upstreamRaw.ok) return upstreamRaw;
  if (!rangeDiffRaw.ok) return rangeDiffRaw;
  const status = requireExit0(statusRaw.value, ["status"]);
  if (!status.ok) return status;
  const local = requireExit0(localRaw.value, ["log"]);
  if (!local.ok) return local;
  const remote = requireExit0(upstreamRaw.value, ["log"]);
  if (!remote.ok) return remote;
  const rangeDiff = requireExit0(rangeDiffRaw.value, ["range-diff"]);
  if (!rangeDiff.ok) return rangeDiff;

  const localCommits = parseDivergenceCommits(local.value.stdout);
  const upstreamCommits = parseDivergenceCommits(remote.value.stdout);
  const alignedCommits = parseRangeDiff(
    rangeDiff.value.stdout,
    localCommits,
    upstreamCommits
  );
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
    alignedCommits,
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

async function resolveFetchedRemoteBranch(
  git: GitExec,
  cwd: string,
  remoteRef: string
): Promise<Result<string>> {
  if (
    !remoteRef.startsWith("refs/remotes/") ||
    remoteRef.slice("refs/remotes/".length).split("/").length < 2
  ) {
    return err({
      kind: "remote",
      code: "invalid_remote_ref",
      message: "The reset target must be a fetched remote-tracking branch."
    });
  }

  const formatRaw = await git(["check-ref-format", remoteRef], cwd);
  if (!formatRaw.ok) return formatRaw;
  if (formatRaw.value.exitCode !== 0) {
    return err({
      kind: "remote",
      code: "invalid_remote_ref",
      message: "The selected remote-tracking branch name is invalid."
    });
  }

  const refRaw = await git(["show-ref", "--verify", "--hash", remoteRef], cwd);
  if (!refRaw.ok) return refRaw;
  if (refRaw.value.exitCode !== 0 || refRaw.value.stdout.trim() === "") {
    return err({
      kind: "remote",
      code: "remote_ref_missing",
      message:
        "The selected fetched remote-tracking branch no longer exists. Refresh and review the reset again."
    });
  }

  // refs/remotes/<name>/HEAD is usually a symbolic convenience ref, not a
  // fetched branch tip. Never allow it (or any other symbolic remote ref) to
  // stand in for the concrete branch the user selected.
  const symbolicRaw = await git(["symbolic-ref", "--quiet", remoteRef], cwd);
  if (!symbolicRaw.ok) return symbolicRaw;
  if (symbolicRaw.value.exitCode === 0) {
    return err({
      kind: "remote",
      code: "invalid_remote_ref",
      message: "Select a fetched remote branch, not a symbolic remote HEAD."
    });
  }

  const head = refRaw.value.stdout.trim();
  const typeRaw = await git(["cat-file", "-t", head], cwd);
  if (!typeRaw.ok) return typeRaw;
  if (typeRaw.value.exitCode !== 0 || typeRaw.value.stdout.trim() !== "commit") {
    return err({
      kind: "remote",
      code: "invalid_remote_ref",
      message: "The selected remote-tracking branch does not point to a commit."
    });
  }
  return ok(head);
}

/** Resolve the exact checkout and fetched remote tip presented for reset. */
export async function inspectRemoteReset(
  git: GitExec,
  cwd: string,
  remoteRef: string
): Promise<Result<RemoteResetSnapshot>> {
  const checkout = await resolveCheckedOutRef(git, cwd);
  if (!checkout.ok) return checkout;
  const remoteHead = await resolveFetchedRemoteBranch(git, cwd, remoteRef);
  if (!remoteHead.ok) return remoteHead;
  return ok({
    branch: checkout.value.branch,
    head: checkout.value.head,
    remoteRef,
    remoteHead: remoteHead.value
  });
}

/**
 * Apply Git's soft/hard reset semantics only to the exact checkout and fetched
 * remote-tracking tip reviewed by the user. Dirty state is intentional input:
 * soft preserves it and hard may discard tracked changes after confirmation.
 */
export async function resetToRemote(
  git: GitExec,
  cwd: string,
  expected: RemoteResetSnapshot,
  mode: RemoteResetMode
): Promise<Result<void>> {
  if (mode !== "soft" && mode !== "hard") {
    return err({
      kind: "remote",
      code: "invalid_reset_mode",
      message: "Choose either a soft or hard reset."
    });
  }

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
        "The checked-out branch or commit changed while this reset was open. Review the current checkout again."
    });
  }

  const remoteHead = await resolveFetchedRemoteBranch(
    git,
    cwd,
    expected.remoteRef
  );
  if (!remoteHead.ok) return remoteHead;
  if (remoteHead.value !== expected.remoteHead) {
    return err({
      kind: "remote",
      code: "remote_ref_changed",
      message:
        "The fetched remote-tracking branch changed while this reset was open. Review its current tip again."
    });
  }

  // Re-read after resolving the remote ref so a checkout changed during that
  // inspection is rejected before Git is asked to move anything.
  const finalCheckout = await resolveCheckedOutRef(git, cwd);
  if (!finalCheckout.ok) return finalCheckout;
  if (
    finalCheckout.value.branch !== expected.branch ||
    finalCheckout.value.head !== expected.head
  ) {
    return err({
      kind: "remote",
      code: "checkout_changed",
      message:
        "The checked-out branch or commit changed while this reset was open. Review the current checkout again."
    });
  }

  const raw = await git(["reset", `--${mode}`, expected.remoteHead], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(undefined);
  return err({
    kind: "remote",
    code: "reset_failed",
    message:
      raw.value.stderr.trim() ||
      `Could not ${mode}-reset the local branch to the selected remote branch.`
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
  cwd: string,
  onProgress: (phase: PullProgressPhase) => void = () => undefined,
  control: PullExecutionControl = {}
): Promise<Result<PullOutcome>> {
  const pullGit = controlledGit(git, control);
  const originalHeadArgs = ["rev-parse", "--verify", "HEAD"];
  const originalHeadRaw = await pullGit(originalHeadArgs, cwd);
  if (!originalHeadRaw.ok) return originalHeadRaw;
  const originalHead = requireExit0(originalHeadRaw.value, originalHeadArgs);
  let originalHeadOid: string | undefined;
  if (originalHead.ok) {
    originalHeadOid = originalHead.value.stdout.trim();
  } else {
    // A symbolic HEAD with no commit is a valid tracked unborn branch. Other
    // rev-parse failures still abort before pull mutates the checkout.
    const symbolicHeadRaw = await pullGit(
      ["symbolic-ref", "--quiet", "HEAD"],
      cwd
    );
    if (!symbolicHeadRaw.ok) return symbolicHeadRaw;
    const symbolicHead = requireExit0(symbolicHeadRaw.value, [
      "symbolic-ref",
      "--quiet",
      "HEAD"
    ]);
    if (!symbolicHead.ok) return originalHead;
  }

  onProgress("fetch");
  // Force progress even though PwrGit captures stderr instead of attaching a
  // terminal. The watchdog treats those records as proof the transfer is alive.
  const fetched = await fetchRemote(pullGit, cwd, true);
  if (!fetched.ok) return fetched;

  const upstream = await resolveUpstream(pullGit, cwd);
  if (!upstream.ok) return upstream;

  // A filter can fail after checkout has written paths that only exist in the
  // incoming commit. Record that bounded pathset before any mutation so
  // rollback never has to clean unrelated untracked files repository-wide.
  const incomingPathArgs =
    originalHeadOid === undefined
      ? ["ls-tree", "-r", "--name-only", "-z", upstream.value.head]
      : [
          "diff",
          "--name-only",
          "-z",
          "--diff-filter=A",
          "--no-renames",
          originalHeadOid,
          upstream.value.head,
          "--"
        ];
  const incomingPathsRaw = await pullGit(incomingPathArgs, cwd);
  if (!incomingPathsRaw.ok) return incomingPathsRaw;
  const incomingPathsResult = requireExit0(
    incomingPathsRaw.value,
    incomingPathArgs
  );
  if (!incomingPathsResult.ok) return incomingPathsResult;
  const incomingPaths = incomingPathsResult.value.stdout
    .split("\0")
    .filter((path) => path !== "");

  onProgress("prepare");
  const statusRaw = await pullGit(["status", "--porcelain"], cwd);
  if (!statusRaw.ok) return statusRaw;
  const status = requireExit0(statusRaw.value, ["status", "--porcelain"]);
  if (!status.ok) return status;
  const dirty = status.value.stdout.trim() !== "";

  let stashed = false;
  if (dirty) {
    const stashArgs = [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "pwrgit: auto-stash before pull"
    ];
    const stashRaw = await pullGit(stashArgs, cwd);
    if (!stashRaw.ok) return stashRaw;
    const stash = requireExit0(stashRaw.value, stashArgs);
    if (!stash.ok) return stash;
    stashed = !/no local changes to save/i.test(stash.value.stdout);
  }

  const rollbackFailedMerge = async (): Promise<Result<void>> => {
    const recoveryControl = control.startRecovery?.();
    const recoveryGit = controlledGit(git, recoveryControl ?? {});
    const rollbackStep = async (args: string[]): Promise<Result<void>> => {
      const raw = await recoveryGit(args, cwd);
      if (raw.ok && raw.value.exitCode === 0) return ok(undefined);
      if (!raw.ok && isPullTimeout(raw.error)) return raw;
      const detail = raw.ok
        ? `${raw.value.stderr}\n${raw.value.stdout}`.trim()
        : raw.error.message;
      return err({
        kind: "remote",
        code: "pull_rollback_failed",
        message: `Pull failed, and PwrGit could not restore the original checkout.${
          stashed ? " Your local changes remain in the stash." : ""
        }${detail !== "" ? ` ${detail}` : ` git ${args.join(" ")} failed.`}`,
        cause: raw.ok ? raw.value : raw.error
      });
    };

    const run = async (): Promise<Result<void>> => {
      if (originalHeadOid !== undefined) {
        const reset = await rollbackStep(["reset", "--hard", originalHeadOid]);
        if (!reset.ok) return reset;
      } else {
        // Restore an unborn checkout even if the failed merge created its branch
        // ref or partially populated the index/worktree.
        for (const args of [
          ["update-ref", "-d", "HEAD"],
          ["read-tree", "--empty"]
        ]) {
          const step = await rollbackStep(args);
          if (!step.ok) return step;
        }
      }

      // reset --hard does not remove paths that are untracked relative to the
      // original commit. Limit cleanup to paths newly tracked upstream, in
      // bounded argument chunks; files created concurrently elsewhere survive.
      const cleanPrefix = ["--literal-pathspecs", "clean", "-fd", "--"];
      let cleanArgs = [...cleanPrefix];
      let cleanArgLength = cleanArgs.join(" ").length;
      const flushClean = async (): Promise<Result<void>> => {
        if (cleanArgs.length === cleanPrefix.length) return ok(undefined);
        const cleaned = await rollbackStep(cleanArgs);
        cleanArgs = [...cleanPrefix];
        cleanArgLength = cleanArgs.join(" ").length;
        return cleaned;
      };
      for (const path of incomingPaths) {
        if (
          cleanArgs.length > cleanPrefix.length &&
          cleanArgLength + path.length + 1 > 24_000
        ) {
          const cleaned = await flushClean();
          if (!cleaned.ok) return cleaned;
        }
        cleanArgs.push(path);
        cleanArgLength += path.length + 1;
      }
      const cleaned = await flushClean();
      if (!cleaned.ok) return cleaned;

      if (!stashed) return ok(undefined);
      onProgress("reapply");
      const pop = await recoveryGit(["stash", "pop", "--index"], cwd);
      if (!pop.ok && isPullTimeout(pop.error)) return pop;
      if (!pop.ok || pop.value.exitCode !== 0) {
        const detail = pop.ok
          ? `${pop.value.stderr}\n${pop.value.stdout}`.trim()
          : pop.error.message;
        return err({
          kind: "remote",
          code: "stash_reapply_failed",
          message: `Pull failed and PwrGit restored the original commit, but your stashed changes could not be reapplied. The stash was kept.${
            detail !== "" ? ` ${detail}` : ""
          }`,
          cause: pop.ok ? pop.value : pop.error
        });
      }
      return ok(undefined);
    };

    let succeeded = false;
    try {
      const result = await run();
      succeeded = result.ok;
      return result;
    } finally {
      recoveryControl?.finish?.(succeeded);
    }
  };

  onProgress("fast_forward");
  const merge = await pullGit(
    ["merge", "--ff-only", "--progress", upstream.value.head],
    cwd
  );
  if (!merge.ok) {
    const rollback = await rollbackFailedMerge();
    if (!rollback.ok) return rollback;
    return merge;
  }
  if (merge.value.exitCode !== 0) {
    const rollback = await rollbackFailedMerge();
    if (!rollback.ok) return rollback;
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
  // Reapply the stashed work, including its staged state. When an indexed pop
  // rejects a conflict before changing the tree, retry without --index so Git
  // can leave the usual conflict markers. Never retry over partial changes.
  onProgress("reapply");
  let pop = await pullGit(["stash", "pop", "--index"], cwd);
  if (!pop.ok) return pop;
  if (pop.value.exitCode !== 0) {
    const statusAfterPopRaw = await pullGit(["status", "--porcelain"], cwd);
    if (!statusAfterPopRaw.ok) return statusAfterPopRaw;
    const statusAfterPop = requireExit0(statusAfterPopRaw.value, [
      "status",
      "--porcelain"
    ]);
    if (!statusAfterPop.ok) return statusAfterPop;
    if (statusAfterPop.value.stdout.trim() === "") {
      pop = await pullGit(["stash", "pop"], cwd);
      if (!pop.ok) return pop;
    }
  }
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

/**
 * Discard every uncommitted change in a worktree. Restore tracked and staged
 * paths from HEAD in one operation, then remove untracked (but not ignored)
 * files and directories in one clean operation. Destructive — callers confirm
 * first.
 */
export async function discardAllChanges(
  git: GitExec,
  cwd: string
): Promise<Result<void>> {
  const restoreArgs = [
    "restore",
    "--source=HEAD",
    "--staged",
    "--worktree",
    "--",
    "."
  ];
  const restored = await git(restoreArgs, cwd);
  if (!restored.ok) return restored;
  const checkedRestore = requireExit0(restored.value, restoreArgs);
  if (!checkedRestore.ok) {
    // An unborn repository has no HEAD tree to restore. Confirm that specific
    // condition before falling back so an unrelated restore failure never
    // triggers more destructive work.
    const symbolicArgs = ["symbolic-ref", "--quiet", "HEAD"];
    const symbolic = await git(symbolicArgs, cwd);
    if (!symbolic.ok) return symbolic;
    if (symbolic.value.exitCode !== 0) return checkedRestore;
    const headRef = symbolic.value.stdout.trim();
    if (!headRef.startsWith("refs/heads/")) return checkedRestore;

    // A missing branch ref proves HEAD is unborn. An existing ref whose object
    // cannot be resolved is corrupt, and must retain the original restore error
    // without clearing recoverable index/worktree data. Other probe failures
    // are also unsafe to treat as an unborn branch.
    const refArgs = ["show-ref", "--verify", "--quiet", headRef];
    const ref = await git(refArgs, cwd);
    if (!ref.ok) return ref;
    if (ref.value.exitCode !== 1) return checkedRestore;

    // Make staged additions untracked so the clean below removes them too.
    const clearArgs = ["read-tree", "--empty"];
    const cleared = await git(clearArgs, cwd);
    if (!cleared.ok) return cleared;
    const checkedClear = requireExit0(cleared.value, clearArgs);
    if (!checkedClear.ok) return checkedClear;
  }

  // `git clean` excludes ignored paths unless `-x`/`-X` is supplied.
  const cleanArgs = ["clean", "-fd"];
  const cleaned = await git(cleanArgs, cwd);
  if (!cleaned.ok) return cleaned;
  const checkedClean = requireExit0(cleaned.value, cleanArgs);
  return checkedClean.ok ? ok(undefined) : checkedClean;
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

const REPO_REFS_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(objectname)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(committerdate:iso8601-strict)",
  "%(contents:subject)"
].join("%09");

type RepoRefRow = {
  fullName: string;
  shortName: string;
  head: string;
  upstream: string;
  track: string;
  lastCommitAt: string;
  subject: string;
};

/** Parse repository ref rows separately from remote configuration metadata. */
export function parseRepoRefRows(stdout: string): RepoRefRow[] {
  const rows: RepoRefRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    const [
      fullName = "",
      shortName = "",
      head = "",
      upstream = "",
      track = "",
      lastCommitAt = ""
    ] = fields;
    if (fullName === "" || shortName === "" || head === "") continue;
    rows.push({
      fullName,
      shortName,
      head,
      upstream,
      track,
      lastCommitAt,
      subject: fields.slice(6).join("\t")
    });
  }
  return rows;
}

function trackingStatus(
  upstream: string,
  track: string
): Pick<LocalBranchSummary, "ahead" | "behind" | "tracking"> {
  if (upstream === "") {
    return { ahead: 0, behind: 0, tracking: "unpublished" };
  }
  if (/gone/i.test(track)) {
    return { ahead: 0, behind: 0, tracking: "upstream_missing" };
  }
  const ahead = Number(/ahead\s+(\d+)/i.exec(track)?.[1] ?? 0);
  const behind = Number(/behind\s+(\d+)/i.exec(track)?.[1] ?? 0);
  let tracking: BranchTrackingStatus = "up_to_date";
  if (ahead > 0 && behind > 0) tracking = "diverged";
  else if (ahead > 0) tracking = "ahead";
  else if (behind > 0) tracking = "behind";
  return { ahead, behind, tracking };
}

export async function listRemoteNames(
  git: GitExec,
  cwd: string
): Promise<Result<string[]>> {
  const raw = await git(["remote"], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["remote"]);
  if (!checked.ok) return checked;
  return ok(
    checked.value.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== "")
  );
}

async function remoteValue(
  git: GitExec,
  cwd: string,
  args: string[]
): Promise<string> {
  const raw = await git(args, cwd);
  return raw.ok && raw.value.exitCode === 0 ? raw.value.stdout.trim() : "";
}

async function remoteSummary(
  git: GitExec,
  cwd: string,
  name: string,
  rows: RepoRefRow[]
): Promise<RemoteSummary> {
  const [fetchUrl, pushUrl, symbolicHead, skipFetchAll] = await Promise.all([
    remoteValue(git, cwd, ["remote", "get-url", name]),
    remoteValue(git, cwd, ["remote", "get-url", "--push", name]),
    remoteValue(git, cwd, [
      "symbolic-ref",
      "--quiet",
      `refs/remotes/${name}/HEAD`
    ]),
    remoteValue(git, cwd, [
      "config",
      "--bool",
      "--get",
      `remote.${name}.skipFetchAll`
    ])
  ]);
  const prefix = `refs/remotes/${name}/`;
  const branches = rows
    .filter(
      (row) => row.fullName.startsWith(prefix) && !row.fullName.endsWith("/HEAD")
    )
    .map((row) => ({
      name: row.fullName.slice(prefix.length),
      qualifiedName: row.shortName,
      fullName: row.fullName,
      head: row.head,
      ...(row.lastCommitAt === "" ? {} : { lastCommitAt: row.lastCommitAt }),
      ...(row.subject === "" ? {} : { subject: row.subject })
    }));
  const headPrefix = `refs/remotes/${name}/`;
  return {
    name,
    fetchUrl,
    pushUrl: pushUrl || fetchUrl,
    ...(symbolicHead.startsWith(headPrefix)
      ? { defaultBranch: symbolicHead.slice(headPrefix.length) }
      : {}),
    skipFetchAll: skipFetchAll === "true",
    branches
  };
}

/**
 * Repository-wide local branch relationships and fetched remote snapshots.
 * One `for-each-ref` keeps branch-heavy repositories cheap; remote metadata
 * costs a few bounded configuration probes per configured endpoint.
 */
export async function listRepoRefs(
  git: GitExec,
  cwd: string,
  checkedOutByBranch: ReadonlyMap<string, string[]> = new Map()
): Promise<Result<RepoRefs>> {
  const [names, raw] = await Promise.all([
    listRemoteNames(git, cwd),
    git(
      [
        "for-each-ref",
        "--sort=-committerdate",
        `--format=${REPO_REFS_FORMAT}`,
        "refs/heads",
        "refs/remotes"
      ],
      cwd
    )
  ]);
  if (!names.ok) return names;
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;
  const rows = parseRepoRefRows(checked.value.stdout);
  const branches = rows
    .filter((row) => row.fullName.startsWith("refs/heads/"))
    .map((row): LocalBranchSummary => {
      const status = trackingStatus(row.upstream, row.track);
      return {
        name: row.shortName,
        fullName: row.fullName,
        head: row.head,
        ...(row.upstream === "" ? {} : { upstream: row.upstream }),
        ...status,
        checkedOutWorktreeIds: checkedOutByBranch.get(row.shortName) ?? [],
        ...(row.lastCommitAt === "" ? {} : { lastCommitAt: row.lastCommitAt }),
        ...(row.subject === "" ? {} : { subject: row.subject })
      };
    });
  const remotes = await Promise.all(
    names.value.map((name) => remoteSummary(git, cwd, name, rows))
  );
  return ok({ branches, remotes });
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

async function checkedDestinationBranch(
  git: GitExec,
  cwd: string,
  branch: string
): Promise<Result<void>> {
  const raw = await git(["check-ref-format", `refs/heads/${branch}`], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(undefined);
  return err({
    kind: "remote",
    code: "invalid_branch",
    message: `\"${branch}\" is not a valid remote branch name.`
  });
}

async function resolveCommit(
  git: GitExec,
  cwd: string,
  ref: string
): Promise<Result<string>> {
  if (
    !ref.startsWith("refs/heads/") &&
    !ref.startsWith("refs/remotes/")
  ) {
    return err({
      kind: "remote",
      code: "invalid_source",
      message: "The push source must be a local or fetched remote branch."
    });
  }
  const raw = await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(raw.value.stdout.trim());
  return err({
    kind: "remote",
    code: "source_missing",
    message: "The selected source branch no longer exists. Refresh and try again."
  });
}

async function remotePushUrl(
  git: GitExec,
  cwd: string,
  remote: string
): Promise<Result<string>> {
  const raw = await git(["remote", "get-url", "--push", remote], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return err({
      kind: "remote",
      code: "inspect_failed",
      message:
        raw.value.stderr.trim() || `Could not resolve the push URL for ${remote}.`
    });
  }
  const url = raw.value.stdout.trim();
  return url === ""
    ? err({
        kind: "remote",
        code: "inspect_failed",
        message: `Could not resolve the push URL for ${remote}.`
      })
    : ok(url);
}

async function remoteHead(
  git: GitExec,
  cwd: string,
  pushUrl: string,
  branch: string
): Promise<Result<string | undefined>> {
  const raw = await git(
    ["ls-remote", "--heads", pushUrl, `refs/heads/${branch}`],
    cwd
  );
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return err({
      kind: "remote",
      code: "inspect_failed",
      message: raw.value.stderr.trim() || "Could not inspect the push endpoint."
    });
  }
  const head = raw.value.stdout.trim().split(/\s+/)[0];
  return ok(head === "" || head === undefined ? undefined : head);
}

async function ensureCommitObject(
  git: GitExec,
  cwd: string,
  pushUrl: string,
  branch: string,
  head: string
): Promise<Result<void>> {
  const have = await git(["cat-file", "-e", `${head}^{commit}`], cwd);
  if (!have.ok) return have;
  if (have.value.exitCode === 0) return ok(undefined);
  const fetched = await git(["fetch", pushUrl, `refs/heads/${branch}`], cwd);
  if (!fetched.ok) return fetched;
  const checked = requireExit0(fetched.value, [
    "fetch",
    pushUrl,
    `refs/heads/${branch}`
  ]);
  return checked.ok ? ok(undefined) : checked;
}

async function pushRelation(
  git: GitExec,
  cwd: string,
  sourceHead: string,
  destinationHead: string | undefined
): Promise<Result<PushRefPlan["relation"]>> {
  if (destinationHead === undefined) return ok("create");
  if (sourceHead === destinationHead) return ok("equal");
  const canFastForward = await git(
    ["merge-base", "--is-ancestor", destinationHead, sourceHead],
    cwd
  );
  if (!canFastForward.ok) return canFastForward;
  if (canFastForward.value.exitCode === 0) return ok("fast_forward");
  const destinationAhead = await git(
    ["merge-base", "--is-ancestor", sourceHead, destinationHead],
    cwd
  );
  if (!destinationAhead.ok) return destinationAhead;
  return ok(
    destinationAhead.value.exitCode === 0 ? "destination_ahead" : "diverged"
  );
}

function sourceRemote(
  sourceRef: string,
  remoteNames: string[]
): string | undefined {
  return remoteNames
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((name) => sourceRef.startsWith(`refs/remotes/${name}/`));
}

/**
 * Refresh all endpoints involved in a proposed push and return an exact,
 * reviewable relationship snapshot for each destination.
 */
export async function planPushRefs(
  git: GitExec,
  cwd: string,
  sourceRef: string,
  destinations: { remote: string; branch: string }[]
): Promise<Result<PushRefPlan[]>> {
  if (destinations.length === 0) {
    return err({
      kind: "remote",
      code: "no_destination",
      message: "Choose at least one destination remote."
    });
  }
  const names = await listRemoteNames(git, cwd);
  if (!names.ok) return names;
  const known = new Set(names.value);
  for (const destination of destinations) {
    if (!known.has(destination.remote)) {
      return err({
        kind: "remote",
        code: "remote_missing",
        message: `Remote \"${destination.remote}\" no longer exists.`
      });
    }
    const valid = await checkedDestinationBranch(
      git,
      cwd,
      destination.branch
    );
    if (!valid.ok) return valid;
  }

  const refreshNames = new Set(destinations.map((d) => d.remote));
  const sourceRemoteName = sourceRemote(sourceRef, names.value);
  if (sourceRemoteName !== undefined) refreshNames.add(sourceRemoteName);
  for (const remote of refreshNames) {
    const fetched = await fetchNamedRemote(git, cwd, remote);
    if (!fetched.ok) return fetched;
  }

  const source = await resolveCommit(git, cwd, sourceRef);
  if (!source.ok) return source;
  const sourceLabel = sourceRef
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
  const plans: PushRefPlan[] = [];
  const seen = new Set<string>();
  for (const destination of destinations) {
    const key = `${destination.remote}\0${destination.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pushUrl = await remotePushUrl(git, cwd, destination.remote);
    if (!pushUrl.ok) return pushUrl;
    const destinationHead = await remoteHead(
      git,
      cwd,
      pushUrl.value,
      destination.branch
    );
    if (!destinationHead.ok) return destinationHead;
    if (destinationHead.value !== undefined) {
      const have = await ensureCommitObject(
        git,
        cwd,
        pushUrl.value,
        destination.branch,
        destinationHead.value
      );
      if (!have.ok) return have;
    }
    const relation = await pushRelation(
      git,
      cwd,
      source.value,
      destinationHead.value
    );
    if (!relation.ok) return relation;
    plans.push({
      sourceRef,
      sourceLabel,
      sourceHead: source.value,
      destinationRemote: destination.remote,
      destinationBranch: destination.branch,
      ...(destinationHead.value === undefined
        ? {}
        : { destinationHead: destinationHead.value }),
      relation: relation.value
    });
  }
  return ok(plans);
}

/** Execute reviewed pushes with a lease and a fresh ancestry check per target. */
export async function pushPlannedRefs(
  git: GitExec,
  cwd: string,
  plans: PushRefPlan[]
): Promise<Result<PushRefResult[]>> {
  const results: PushRefResult[] = [];
  const refreshed = new Set<string>();
  for (const plan of plans) {
    const base = {
      destinationRemote: plan.destinationRemote,
      destinationBranch: plan.destinationBranch
    };
    const source = await resolveCommit(git, cwd, plan.sourceRef);
    if (!source.ok || source.value !== plan.sourceHead) {
      results.push({
        ...base,
        outcome: "failed",
        message: "The source branch changed after review. Refresh the plan."
      });
      continue;
    }
    const pushUrl = await remotePushUrl(git, cwd, plan.destinationRemote);
    if (!pushUrl.ok) {
      results.push({
        ...base,
        outcome: "failed",
        message: pushUrl.error.message
      });
      continue;
    }
    const actual = await remoteHead(
      git,
      cwd,
      pushUrl.value,
      plan.destinationBranch
    );
    if (!actual.ok || actual.value !== plan.destinationHead) {
      results.push({
        ...base,
        outcome: "failed",
        message: "The destination changed after review. Refresh the plan."
      });
      continue;
    }
    if (actual.value !== undefined) {
      const have = await ensureCommitObject(
        git,
        cwd,
        pushUrl.value,
        plan.destinationBranch,
        actual.value
      );
      if (!have.ok) {
        results.push({ ...base, outcome: "failed", message: have.error.message });
        continue;
      }
    }
    const relation = await pushRelation(git, cwd, plan.sourceHead, actual.value);
    if (!relation.ok) {
      results.push({
        ...base,
        outcome: "failed",
        message: relation.error.message
      });
      continue;
    }
    if (relation.value === "equal") {
      results.push({ ...base, outcome: "up_to_date" });
      continue;
    }
    if (relation.value !== "create" && relation.value !== "fast_forward") {
      results.push({
        ...base,
        outcome: "failed",
        message:
          relation.value === "destination_ahead"
            ? "The destination contains commits missing from the source."
            : "The source and destination have diverged."
      });
      continue;
    }
    const expected = actual.value ?? "";
    const destinationRef = `refs/heads/${plan.destinationBranch}`;
    const raw = await git(
      [
        "push",
        `--force-with-lease=${destinationRef}:${expected}`,
        pushUrl.value,
        `${plan.sourceHead}:${destinationRef}`
      ],
      cwd
    );
    if (!raw.ok || raw.value.exitCode !== 0) {
      results.push({
        ...base,
        outcome: "failed",
        message:
          raw.ok
            ? raw.value.stderr.trim() || "Push failed."
            : raw.error.message
      });
      continue;
    }
    results.push({ ...base, outcome: "pushed" });
    refreshed.add(plan.destinationRemote);
  }
  for (const remote of refreshed) await fetchNamedRemote(git, cwd, remote);
  return ok(results);
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
