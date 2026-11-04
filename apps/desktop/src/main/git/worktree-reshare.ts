import type {
  BulkSyncWorktreeResult,
  MaintenanceRepo,
  MaintenanceRepoResult,
  ReshareMainCheckout,
  ReshareWorktreeResult
} from "@pwrgit/shared";
import { mapLimit } from "../util/map-limit";
import { bulkSyncRepositories } from "./bulk-sync";
import { sanitizeGitLogDetail, type GitExec } from "./dugite";

/** Worktrees re-shared at once inside one repository. Each pass is serial
 *  inside Git and reads the same donor, so two keeps the disk busy without
 *  piling every worktree of a 40-worktree repository onto it. */
export const RESHARE_WORKTREE_CONCURRENCY = 2;

/** One `name value` record of `git worktree reflink --porcelain -z`. */
type PorcelainRecord = Map<string, string>;

export type ReflinkPorcelain = {
  header: PorcelainRecord;
  paths: PorcelainRecord[];
  summary: PorcelainRecord | null;
};

/**
 * Parse `git worktree reflink --porcelain -z`: NUL ends every field, and an
 * empty field ends a record. The first record is the header (`reflink 1`),
 * then one per index entry (`path …`), then `summary`. Unknown fields and
 * reasons are kept as they come, as the format asks of consumers.
 */
export function parseReflinkPorcelain(stdout: string): ReflinkPorcelain {
  const records: PorcelainRecord[] = [];
  let current: PorcelainRecord = new Map();
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (current.size > 0) records.push(current);
      current = new Map();
      continue;
    }
    const space = field.indexOf(" ");
    current.set(space < 0 ? field : field.slice(0, space), space < 0 ? "" : field.slice(space + 1));
  }
  if (current.size > 0) records.push(current);
  const header = records.find((record) => record.has("reflink")) ?? new Map<string, string>();
  return {
    header,
    paths: records.filter((record) => record.has("path")),
    summary: records.find((record) => record.has("summary")) ?? null
  };
}

const count = (record: PorcelainRecord | null, key: string): number => {
  const value = Number(record?.get(key));
  return Number.isFinite(value) ? value : 0;
};

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Git's skip reasons, as the receipt words them. Unknown ones are shown
 *  with their dashes turned to spaces. */
const REASON_WORDS: Record<string, string> = {
  "target-dirty": "changed",
  "target-changed": "changed during the pass",
  "target-unavailable": "missing",
  "no-donor": "differ from the main checkout",
  "hardlinked-target": "hard-linked",
  "different-filesystem": "on another volume",
  "representation-differs": "stored differently (line endings)",
  "conversion-unsupported": "filtered",
  "working-tree-encoding": "re-encoded",
  "special-metadata": "special permissions"
};

/** Symlinks, submodules and sparse entries: never candidates, so naming
 *  them as a reason only crowds out the ones a reader can act on. */
const QUIET_REASONS = new Set(["index-entry", "fully-shared", ""]);

/** Summarise a worktree's answer in the receipt's words. */
export function reshareResultFromPorcelain(
  worktree: { id: string; path: string; branch: string },
  porcelain: ReflinkPorcelain,
  exitCode: number,
  stderr: string
): ReshareWorktreeResult {
  const { summary } = porcelain;
  const reshared = count(summary, "reshared");
  const alreadyShared = count(summary, "already-shared");
  const failed = count(summary, "failed");
  // Absent or `unknown` when Git could not measure allocation (another
  // filesystem); a count of zero is a real answer.
  const reduction = Number(summary?.get("observed-private-reduction") ?? Number.NaN);
  // Group skip reasons so the line says why files were left, not only how
  // many. Symlinks, submodules and sparse entries are never candidates, so
  // they leave the count as well as the reasons.
  const reasons = new Map<string, number>();
  let quiet = 0;
  for (const record of porcelain.paths) {
    if (record.get("status") !== "skipped") continue;
    const reason = record.get("reason") ?? "";
    if (QUIET_REASONS.has(reason)) quiet += 1;
    else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const skipped = Math.max(0, count(summary, "skipped") - quiet);
  const base = {
    worktreeId: worktree.id,
    path: worktree.path,
    branch: worktree.branch,
    reshared,
    alreadyShared,
    skipped,
    failed,
    sharedBytes: Number.isFinite(reduction) ? reduction : null
  };
  if (summary === null) {
    return {
      ...base,
      outcome: "failed",
      message: sanitizeGitLogDetail(stderr.trim() || `Git exited ${exitCode} without a summary.`)
    };
  }
  if (porcelain.header.get("backend") === "unsupported") {
    return { ...base, outcome: "skipped", message: "This volume can’t share file data; files were left as they are." };
  }
  const why = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([reason, n]) => `${n.toLocaleString("en-US")} ${REASON_WORDS[reason] ?? reason.replaceAll("-", " ")}`)
    .join(", ");
  const parts = [
    reshared > 0 ? `${plural(reshared, "file")} re-shared` : null,
    alreadyShared > 0 ? `${alreadyShared.toLocaleString("en-US")} already shared` : null,
    skipped > 0 ? `${skipped.toLocaleString("en-US")} left as they are${why === "" ? "" : ` (${why})`}` : null,
    failed > 0 ? `${plural(failed, "file")} failed` : null
  ].filter((part): part is string => part !== null);
  const message = parts.length > 0 ? `${parts.join(" · ")}.` : "No tracked files to share.";
  if (failed > 0 || exitCode !== 0) {
    const detail = stderr.trim();
    return {
      ...base,
      outcome: "failed",
      message: detail === "" ? message : `${message} ${sanitizeGitLogDetail(detail)}`
    };
  }
  return {
    ...base,
    outcome: reshared > 0 ? "reshared" : alreadyShared > 0 ? "already_shared" : "skipped",
    message
  };
}

/**
 * `git worktree reflink` on one worktree: Git compares actual bytes before it
 * shares anything and leaves changed, untracked and ignored files alone.
 * Never cancelled once started — cooperative cancellation never interrupts a
 * local mutation; the caller stops before the next worktree instead.
 */
export async function reshareWorktree(
  git: GitExec,
  worktree: { id: string; path: string; branch: string }
): Promise<ReshareWorktreeResult> {
  const run = await git(["worktree", "reflink", "--porcelain", "-z"], worktree.path);
  if (!run.ok) {
    return {
      worktreeId: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      outcome: "failed",
      message: sanitizeGitLogDetail(run.error.message),
      reshared: 0,
      alreadyShared: 0,
      skipped: 0,
      failed: 0,
      sharedBytes: null
    };
  }
  return reshareResultFromPorcelain(
    worktree,
    parseReflinkPorcelain(run.value.stdout),
    run.value.exitCode,
    run.value.stderr
  );
}

export type ReshareWorktreeRow = {
  id: string;
  path: string;
  branch: string;
  isPrimary: boolean;
  missing: boolean;
  locked: boolean;
};

export type RefreshClonesDeps = {
  git: GitExec;
  repo: MaintenanceRepo;
  worktrees: ReshareWorktreeRow[];
  updateMain: boolean;
  signal: AbortSignal;
  report: (detail: string) => void;
  /** The repository's default branch name (`main`), or null if unknown. */
  defaultBranch: () => Promise<string | null>;
  /** Try pull's soft pull of the main checkout: fetch, then fast-forward
   *  only a clean, tracked branch. */
  softPull: (primary: ReshareWorktreeRow) => Promise<BulkSyncWorktreeResult>;
  /** Hold a worktree's lock around its re-share. */
  runWorktree: <T>(worktreeId: string, operation: () => Promise<T>) => Promise<T>;
  /** Let a just-written main checkout's index age past Git's racy window. */
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
};

const SKIPPED_PULL_WORDS: Partial<Record<NonNullable<BulkSyncWorktreeResult["reason"]>, string>> = {
  dirty: "it has uncommitted changes",
  conflicts: "it has conflicts",
  in_progress: "an operation is in progress",
  diverged: "it has diverged from its upstream",
  ahead: "it has commits that aren’t pushed",
  no_upstream: "its branch has no upstream",
  detached_head: "its HEAD is detached",
  no_head: "it has no commits",
  authentication: "the remote asked for credentials",
  fetch_failed: "the fetch failed",
  upstream_not_fetched: "its upstream wasn’t fetched",
  unsafe_state: "its state couldn’t be read safely"
};

async function updateMainCheckout(
  deps: RefreshClonesDeps,
  primary: ReshareWorktreeRow | undefined
): Promise<ReshareMainCheckout> {
  if (!deps.updateMain) return { outcome: "not_requested", message: "Main checkout not updated." };
  if (primary === undefined || primary.missing) {
    return { outcome: "left", message: "Main checkout left: its directory is missing." };
  }
  deps.report("Checking the main checkout’s branch…");
  const [defaultBranch, head] = await Promise.all([
    deps.defaultBranch(),
    deps.git(["symbolic-ref", "--quiet", "--short", "HEAD"], primary.path)
  ]);
  const branch = head.ok && head.value.exitCode === 0 ? head.value.stdout.trim() : "";
  const named = { ...(branch === "" ? {} : { branch }), ...(defaultBranch === null ? {} : { defaultBranch }) };
  if (branch === "") return { ...named, outcome: "left", message: "Main checkout left: its HEAD is detached." };
  if (defaultBranch === null) {
    return { ...named, outcome: "left", message: "Main checkout left: the default branch is unknown." };
  }
  if (branch !== defaultBranch) {
    return { ...named, outcome: "left", message: `Main checkout left: it is on ${branch}, not ${defaultBranch}.` };
  }
  const pulled = await deps.softPull(primary);
  switch (pulled.outcome) {
    case "updated":
      return { ...named, outcome: "updated", message: `${branch} fast-forwarded.` };
    case "up_to_date":
      return { ...named, outcome: "up_to_date", message: `${branch} up to date.` };
    case "failed":
      return {
        ...named,
        outcome: "failed",
        message: `Main checkout not updated: ${pulled.message ?? "Git could not fast-forward it."}`
      };
    default:
      return {
        ...named,
        outcome: "left",
        message: `Main checkout left: ${
          (pulled.reason !== undefined ? SKIPPED_PULL_WORDS[pulled.reason] : undefined) ??
          pulled.message ??
          "it couldn’t be fast-forwarded"
        }.`
      };
  }
}

const CANCELLED = "Cancelled before this worktree started.";

/** Why a worktree was not run, beside the result it reports. */
type ReshareRow = { result: ReshareWorktreeResult; notRun?: "cancelled" | "skipped" };

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Maintenance › Clones for one repository, inside its repository lock:
 * bring the main checkout (the clone source) up to its default branch, then
 * re-share every linked worktree. Missing and locked worktrees are reported,
 * never run.
 */
export async function refreshRepositoryClones(deps: RefreshClonesDeps): Promise<MaintenanceRepoResult> {
  const { repo } = deps;
  const primary = deps.worktrees.find((worktree) => worktree.isPrimary);
  const linked = deps.worktrees.filter((worktree) => !worktree.isPrimary);
  if (linked.length === 0) {
    return {
      repo,
      outcome: "skipped",
      message: "No linked worktrees.",
      reshare: { main: { outcome: "not_requested", message: "Main checkout not updated." }, worktrees: [] }
    };
  }
  const main = await updateMainCheckout(deps, primary);
  // A file the fast-forward just wrote has the same timestamp as the index
  // that records it, which Git calls racy and will not use as a clone source.
  // Wait past the timestamp, then let `status` rewrite the index — it does
  // whenever an entry is racy — so the new files can be shared.
  // Its index belongs to the main checkout, so `status` holds that lock.
  if (!deps.signal.aborted && primary !== undefined && !primary.missing) {
    if (main.outcome === "updated") await (deps.sleep ?? delay)(1_100);
    await deps.runWorktree(primary.id, () =>
      deps.git(["status", "--porcelain", "--untracked-files=no"], primary.path)
    );
  }
  let started = 0;
  const reshareOne = async (worktree: ReshareWorktreeRow): Promise<ReshareRow> => {
    const base = {
      worktreeId: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      reshared: 0,
      alreadyShared: 0,
      skipped: 0,
      failed: 0,
      sharedBytes: null
    };
    const cancelledRow: ReshareRow = {
      result: { ...base, outcome: "skipped", message: CANCELLED },
      notRun: "cancelled"
    };
    if (deps.signal.aborted) return cancelledRow;
    if (worktree.missing) {
      return { result: { ...base, outcome: "skipped", message: "Directory missing." }, notRun: "skipped" };
    }
    if (worktree.locked) {
      return { result: { ...base, outcome: "skipped", message: "Locked in Git, so left alone." }, notRun: "skipped" };
    }
    return deps.runWorktree(worktree.id, async (): Promise<ReshareRow> => {
      if (deps.signal.aborted) return cancelledRow;
      started += 1;
      deps.report(`Worktree ${started} of ${linked.length} · ${worktree.branch || "(detached)"}`);
      return { result: await reshareWorktree(deps.git, worktree) };
    });
  };
  // Kept in the worktrees' order, whichever finishes first.
  const rows: ReshareRow[] = new Array<ReshareRow>(linked.length);
  await mapLimit(
    linked.map((worktree, index) => ({ worktree, index })),
    deps.concurrency ?? RESHARE_WORKTREE_CONCURRENCY,
    async ({ worktree, index }) => {
      rows[index] = await reshareOne(worktree);
    }
  );
  const worktrees = rows.map((row) => row.result);
  const cancelled = rows.filter((row) => row.notRun === "cancelled").length;
  const failed = worktrees.filter((worktree) => worktree.outcome === "failed").length;
  const files = worktrees.reduce((sum, worktree) => sum + worktree.reshared, 0);
  const outcome: MaintenanceRepoResult["outcome"] =
    cancelled === worktrees.length
      ? "cancelled"
      : failed === worktrees.length
        ? "failed"
        : failed > 0 || cancelled > 0 || main.outcome === "failed"
          ? "partial"
          : main.outcome !== "updated" && worktrees.every((worktree) => worktree.outcome === "skipped")
            ? "skipped"
            : "success";
  const summary = [
    main.outcome === "not_requested" ? null : main.message.replace(/\.$/, ""),
    plural(linked.length, "worktree"),
    files > 0 ? `${plural(files, "file")} re-shared` : "nothing new to share",
    failed > 0 ? `${failed} failed` : null,
    cancelled > 0 ? `${cancelled} not started` : null
  ].filter((part): part is string => part !== null);
  return { repo, outcome, message: `${summary.join(" · ")}.`, reshare: { main, worktrees } };
}

/**
 * Try pull's own soft pull, on the main checkout alone: the same fetch of
 * every configured remote, the same safety checks, and the same exact-commit
 * fast-forward. The caller already holds the repository lock.
 */
export async function softPullMainCheckout(
  git: GitExec,
  repo: MaintenanceRepo,
  primary: ReshareWorktreeRow,
  options: {
    operationId: string;
    signal: AbortSignal;
    runWorktree: <T>(worktreeId: string, operation: () => Promise<T>) => Promise<T>;
    report: (detail: string) => void;
  }
): Promise<BulkSyncWorktreeResult> {
  const synced = await bulkSyncRepositories(
    git,
    [{ id: repo.id, name: repo.name, path: repo.path, worktrees: [{ id: primary.id, branch: primary.branch, path: primary.path }] }],
    {
      operationId: options.operationId,
      mode: "soft-pull",
      signal: options.signal,
      concurrency: 1,
      runWorktree: options.runWorktree,
      onProgress: (event) => {
        if (event.detail !== undefined) options.report(`Updating the main checkout: ${event.detail}`);
      }
    }
  );
  const row = synced.results[0];
  return (
    row?.worktrees[0] ?? {
      worktreeId: primary.id,
      branch: primary.branch,
      path: primary.path,
      outcome: "failed",
      reason: "fetch_failed",
      message: row?.message ?? "Git could not fetch the repository’s remotes."
    }
  );
}
