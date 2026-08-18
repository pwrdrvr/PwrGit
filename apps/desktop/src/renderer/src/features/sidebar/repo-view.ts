import type { Lens, Repo, Worktree, WorktreeSort } from "@pwrgit/shared";

export const LENSES: Lens[] = ["Recent", "Pinned", "Behind", "Stale", "All"];

/**
 * The folder-row "behind" count reflects the repo's **primary checkout** (its
 * local directory), not a max across all worktrees — a stale feature-branch
 * worktree that's behind its own upstream shouldn't make the whole repo look
 * behind. Falls back to the first worktree if none is flagged primary.
 */
export function repoPrimaryBehind(repo: Repo): number {
  const primary = repo.worktrees.find((w) => w.isPrimary) ?? repo.worktrees[0];
  return primary?.behind ?? 0;
}

/**
 * How many **linked worktrees** a repo has. The primary checkout is the repo's
 * own directory, not a worktree you added — counting it made every repo claim
 * one more than it has, and a repo with nothing but a local checkout read
 * "1 wt" when the honest answer is that it has none. Callers hide the count
 * entirely at 0 rather than printing "0 wts" on most rows in the list.
 */
export function linkedWorktreeCount(repo: Repo): number {
  return repo.worktrees.filter((worktree) => !worktree.isPrimary).length;
}

/**
 * Newest known activity across a repo's worktrees, or `-Infinity` when nothing
 * has been computed for it yet. Worktree state is filled lazily (on expand) but
 * persisted afterwards, so this sharpens as the user works rather than being
 * empty forever — and a repo with no known activity sorts last instead of
 * jumping around.
 */
export function repoLastActivity(repo: Repo): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const worktree of repo.worktrees) {
    if (worktree.lastActivityAt === undefined) continue;
    const at = Date.parse(worktree.lastActivityAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

/** Case-insensitive, natural-numeric: "Foo" sits by "foo", "v2" precedes "v10". */
const byName = (a: Repo, b: Repo): number =>
  a.name.localeCompare(b.name, undefined, {
    sensitivity: "accent",
    numeric: true
  });

export type RepoGroup = { root: string; label: string; repos: Repo[] };

// Repo/root paths arrive with the platform's separators (backslashes on
// Windows); normalize before any prefix or segment math so grouping doesn't
// silently dump every repo into "Other" off-POSIX.
const normalizeSlashes = (path: string): string => path.replace(/\\/g, "/");

// Windows paths (drive-letter prefix) additionally compare case-insensitively:
// repo paths come from `git worktree list`, which reports true-case
// forward-slash paths (C:/Users/runneradmin/…), while picked roots keep the
// shell's casing (C:\Users\RUNNERADMIN\…) — same directory, different string.
const comparablePath = (path: string): string => {
  const normalized = normalizeSlashes(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

/** A path's final segment — the folder a repo or worktree lives in. Exported
 *  because a switch confirm has to name the checkout it would move, and it
 *  names it by folder for the same reason the rows do. */
export const lastSegment = (path: string): string =>
  normalizeSlashes(path).split("/").filter(Boolean).pop() ?? path;

const isUnder = (path: string, root: string): boolean => {
  const p = comparablePath(path);
  const r = comparablePath(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
};

/**
 * Bucket repos by the scan root they live under (longest-prefix wins, so nested
 * roots attribute correctly). Empty groups are dropped; repos under no root land
 * in a trailing "Other" group. Order follows the profile's root order.
 */
export function groupReposByRoot(repos: Repo[], roots: string[]): RepoGroup[] {
  const byLongest = [...roots].sort((a, b) => b.length - a.length);
  const buckets = new Map<string, Repo[]>(roots.map((r) => [r, []]));
  const other: Repo[] = [];
  for (const repo of repos) {
    const root = byLongest.find((r) => isUnder(repo.path, r));
    if (root === undefined) other.push(repo);
    else buckets.get(root)?.push(repo);
  }
  const groups: RepoGroup[] = roots
    .map((r) => ({ root: r, label: lastSegment(r), repos: buckets.get(r) ?? [] }))
    .filter((g) => g.repos.length > 0);
  if (other.length > 0) groups.push({ root: "", label: "Other", repos: other });
  return groups;
}

/** A worktree is "safe to prune": clean, fully merged into the default branch,
 *  not the default/primary checkout, and untouched for a while. */
export const STALE_AGE_DAYS = 14;

export function isPrunableWorktree(w: Worktree, now: number = Date.now()): boolean {
  if (w.isDefaultBranch || w.isPrimary) return false;
  if (w.dirty > 0) return false;
  // A merged PR is definitive — the work is in the base branch, so it's safe to
  // prune at any age. This catches squash/rebase merges that the git-ancestry
  // check below can't see (the original commits aren't in the default branch).
  if (w.pr?.state === "merged") return true;
  // Otherwise fall back to the git heuristic: contained in the default branch,
  // or sharing no history with it (rewritten/orphaned) — both plus old + clean.
  if (!w.mergedIntoDefault && !w.divergedFromDefault) return false;
  if (w.lastActivityAt === undefined) return false;
  const ageMs = now - new Date(w.lastActivityAt).getTime();
  return ageMs > STALE_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function repoIsPinned(r: Repo): boolean {
  return r.pinned || r.worktrees.some((w) => w.pinned);
}

/**
 * Why a repo is in the Pinned lens. The two pins are independent — pinning a
 * worktree pulls its repo into the lens without lighting the repo's own star —
 * so a row can otherwise look like it doesn't belong in the list it's in. The
 * row uses this to say which it is instead of leaving the star ambiguous.
 */
export type RepoPinSource = "repo" | "worktree" | "none";

export function repoPinSource(r: Repo): RepoPinSource {
  if (r.pinned) return "repo";
  if (r.worktrees.some((w) => w.pinned)) return "worktree";
  return "none";
}

function repoHasPrunable(r: Repo, now: number): boolean {
  return r.worktrees.some((w) => isPrunableWorktree(w, now));
}

/**
 * Counts shown on the lens chips.
 *
 * Recent used to be hardcoded 0 on the grounds that it was "the default view,
 * not a filtered set" — but it displayed rows, so the one lens the app opens on
 * was also the only one showing neither a count nor a presence dot. It holds
 * every repo, exactly like All, so it reports the same number.
 */
export function lensCounts(
  repos: Repo[],
  now: number = Date.now()
): Record<Lens, number> {
  return {
    Recent: repos.length,
    Pinned: repos.filter(repoIsPinned).length,
    Behind: repos.filter((r) => r.worktrees.some((w) => w.behind > 0)).length,
    Stale: repos.filter((r) => repoHasPrunable(r, now)).length,
    All: repos.length
  };
}

/**
 * Compact a lens count so the filter row stays inside the sidebar. Five chips
 * share one row, and a four-digit count is wide enough to push the row past
 * what it has — the tracks are floored at their content width, so an
 * unabbreviated "1099" would overflow the pill rather than clip inside it.
 *
 * Truncates rather than rounds: a count is a floor ("at least this many"), so
 * 1999 reads 1.9K, never 2K. One decimal only below 10 of a unit — past that
 * the decimal costs a glyph without telling you anything you'd act on.
 *
 *   999 → "999"    1000 → "1K"     1150 → "1.1K"
 *   1999 → "1.9K"  10_400 → "10K"  1_250_000 → "1.2M"
 */
export function formatLensCount(count: number): string {
  if (!Number.isFinite(count) || count < 1000) return String(count);
  const [value, suffix] =
    count < 1_000_000 ? [count / 1000, "K"] : [count / 1_000_000, "M"];
  // Truncate to one decimal, then drop a trailing ".0" so 1000 reads "1K".
  const truncated = Math.floor(value * 10) / 10;
  const shown = truncated < 10 ? truncated.toFixed(1).replace(/\.0$/, "") : String(Math.floor(truncated));
  return `${shown}${suffix}`;
}

/**
 * Only the Pinned lens is a list the user owns. Recent/Behind/Stale answer a
 * question ("what changed", "what's out of date"), so a hand order there would
 * fight the answer the lens exists to give — hence `orderedByHand` rather than
 * a manual order applied everywhere.
 */
export function lensIsArrangeable(lens: Lens): boolean {
  return lens === "Pinned";
}

/**
 * Sort by the user's arrangement: repos carrying an `order` lead, in it; the
 * rest follow in their incoming order (pinned-first, then name, from SQL).
 * A repo the user has never dragged therefore never jumps around because a
 * neighbor was dragged.
 */
function orderedByHand(list: Repo[]): Repo[] {
  return [...list].sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
}

/**
 * Filter by lens, then order it by whatever that lens is *for*.
 *
 * Recent and All used to be the same call: both fell through to the unfiltered
 * list and took the same pinned-first sort, so two of the five lenses were one
 * view wearing two icons. They hold the same repos on purpose — the difference
 * is the question each answers, which is the ordering:
 *
 * - **All** is the index: strict alphabetical, so a name is findable by
 *   position.
 * - **Recent** is the worklist: newest activity first, unknown-activity repos
 *   last (and alphabetical among themselves, so they don't shuffle).
 *
 * Neither floats pinned repos any more. Pinning already has a lens of its own,
 * and a pin hoisted into All broke the one property — position follows name —
 * that makes an alphabetical index worth having. Behind and Stale keep the
 * float: they are short answer-lists where "mine first" still helps.
 */
export function filterReposByLens(
  repos: Repo[],
  lens: Lens,
  now: number = Date.now()
): Repo[] {
  let list = repos;
  if (lens === "Behind") {
    list = repos.filter((r) => r.worktrees.some((w) => w.behind > 0));
  } else if (lens === "Pinned") {
    list = repos.filter(repoIsPinned);
  } else if (lens === "Stale") {
    list = repos.filter((r) => repoHasPrunable(r, now));
  }
  if (lens === "All") return [...list].sort(byName);
  if (lens === "Recent") {
    return [...list].sort((a, b) => {
      const ta = repoLastActivity(a);
      const tb = repoLastActivity(b);
      // Equal covers "both unknown" (-Infinity === -Infinity), which is what
      // keeps this from evaluating -Inf − -Inf and sorting by NaN.
      if (ta !== tb) return tb - ta;
      return byName(a, b);
    });
  }
  const byPin = [...list].sort(
    (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
  );
  return lensIsArrangeable(lens) ? orderedByHand(byPin) : byPin;
}

export const SORT_CYCLE: Record<Exclude<WorktreeSort, "custom">, WorktreeSort> = {
  recent: "pinned",
  pinned: "az",
  az: "active",
  active: "recent"
};

export const SORT_LABEL: Record<WorktreeSort, string> = {
  recent: "Recent",
  pinned: "Pinned",
  az: "A–Z",
  active: "Active",
  custom: "Custom"
};

/**
 * Order a worktree list. A user drag-order (customOrder) wins; otherwise the
 * selected sort mode applies.
 */
export function orderWorktrees(
  worktrees: Worktree[],
  sort: WorktreeSort,
  customOrder?: string[]
): Worktree[] {
  const list = [...worktrees];
  if (customOrder !== undefined && customOrder.length > 0) {
    const rank = (id: string): number => {
      const i = customOrder.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return list.sort((a, b) => rank(a.id) - rank(b.id));
  }
  if (sort === "recent") {
    // Most recently active first, so live work floats to the top instead of
    // whatever discovery order happened to produce. Rows without a computed
    // timestamp (state not filled yet) sink to the bottom and shuffle into
    // place as their state lands.
    return list.sort((a, b) => {
      const ta =
        a.lastActivityAt !== undefined ? Date.parse(a.lastActivityAt) : -1;
      const tb =
        b.lastActivityAt !== undefined ? Date.parse(b.lastActivityAt) : -1;
      return tb - ta;
    });
  }
  if (sort === "az") {
    // Case-insensitive + natural-numeric, so "Foo" sits by "foo" and "v2"
    // precedes "v10" — not ASCII order with every capital hoisted to the top.
    return list.sort((a, b) =>
      a.branch.localeCompare(b.branch, undefined, {
        sensitivity: "accent",
        numeric: true
      })
    );
  }
  if (sort === "active") {
    return list.sort((a, b) => b.dirty + b.ahead - (a.dirty + a.ahead));
  }
  // "pinned"
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/**
 * Keep the primary checkout and pinned linked worktrees in the always-visible
 * part of an expanded repo. The remaining linked worktrees retain the user's
 * chosen ordering behind the Worktrees disclosure.
 */
export function groupWorktreesForNavigation(
  worktrees: Worktree[],
  sort: WorktreeSort,
  customOrder?: string[]
): {
  primary: Worktree | undefined;
  pinned: Worktree[];
  remaining: Worktree[];
  displayIds: string[];
} {
  const primary = worktrees.find((worktree) => worktree.isPrimary);
  const ordered = orderWorktrees(
    worktrees.filter((worktree) => !worktree.isPrimary),
    sort,
    customOrder
  );
  const pinned = ordered.filter((worktree) => worktree.pinned);
  const remaining = ordered.filter((worktree) => !worktree.pinned);
  return {
    primary,
    pinned,
    remaining,
    displayIds: [
      ...(primary === undefined ? [] : [primary.id]),
      ...pinned.map((worktree) => worktree.id),
      ...remaining.map((worktree) => worktree.id)
    ]
  };
}

// Letters and numbers of any script survive; everything else collapses to a
// single dash, so "feat/new-graph" and "feat-new-graph" compare equal. A branch
// name can hold characters a directory cannot, and the tools that create
// worktrees flatten them differently — comparing the raw strings would then
// print a "folder" that is the branch with its slashes swapped, on every row.
const folderKey = (value: string): string =>
  value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The worktree's own directory name, or null when the branch name already
 * tells you what it is.
 *
 * A worktree's row is titled by its branch, which is normally the same word as
 * the directory it lives in — but nothing keeps them together. Agent-driven
 * checkouts are the case that hurts: the directory is named for whatever branch
 * existed when it was created, the branch is later renamed or recreated, and
 * the row then names something you cannot find on disk (nor, searching for the
 * directory you *are* sitting in, recognise in the results). Detached
 * checkouts have no branch name to go on at all.
 *
 * `impliedBy` takes further names that make the directory redundant — a repo's
 * primary checkout lives in the repo's own folder, which its folder row above
 * already shows.
 */
export function worktreeFolderLabel(
  branch: string,
  path: string,
  impliedBy: (string | undefined)[] = []
): string | null {
  const folder = lastSegment(path);
  if (folder === "") return null;
  const key = folderKey(folder);
  // "feat/graph-x" in a "graph-x" directory is the same name, one segment of it.
  const branchTail = branch.split("/").filter(Boolean).pop() ?? branch;
  const redundant = [branch, branchTail, ...impliedBy].some(
    (name) => name !== undefined && folderKey(name) === key
  );
  return redundant ? null : folder;
}

/** Short relative age label for a last-activity timestamp. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * The only parts of an event the row-selection logic reads. Declared
 * structurally so a click and a keypress both satisfy it — the alternative was
 * casting a KeyboardEvent to a MouseEvent, which type-checks by discarding the
 * very guarantee that made the cast safe.
 */
export type SelectionModifiers = {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
};

/** Which side of the hovered row a drop lands on. */
export type DropPosition = "before" | "after";

/**
 * Move an id to sit next to `targetId` (drag-reorder).
 *
 * `position` is what makes the last slot reachable: with only a "before"
 * insert, no gesture can put a row at the end of the list — you can drop
 * before the final row forever and never past it.
 */
export function reorder(
  ids: string[],
  dragId: string,
  targetId: string,
  position: DropPosition = "before"
): string[] {
  if (dragId === targetId) return ids;
  const next = ids.filter((id) => id !== dragId);
  const at = next.indexOf(targetId);
  if (at === -1) return ids;
  next.splice(position === "after" ? at + 1 : at, 0, dragId);
  return next;
}

/**
 * Where a pointer sitting at `clientY` within `rect` wants to drop: past the
 * row's midpoint means after it. Shared by the repo and worktree lists so both
 * feel identical, and so the indicator drawn during the drag and the splice
 * performed on release can never disagree about which gap was meant.
 */
export function dropPositionWithin(rect: DOMRect, clientY: number): DropPosition {
  return clientY >= rect.top + rect.height / 2 ? "after" : "before";
}
