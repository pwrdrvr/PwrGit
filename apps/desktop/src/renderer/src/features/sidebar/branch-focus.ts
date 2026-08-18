import type { LocalBranchSummary, Worktree, WorktreeId } from "@pwrgit/shared";

/**
 * The sidebar's paired focus: one working target (the selected worktree, which
 * every git verb aims at) and its checked-out branch, which is *derived* from
 * it rather than separately selectable.
 *
 * A worktree is always on exactly one branch, so the branch can never be
 * chosen independently or fall out of sync — which is why a branch row gets a
 * dependent treatment (`is-current`, an accent bar) rather than a second
 * selection box. The reverse direction is partial: a branch has zero or one
 * worktrees, and most branches in a large repo have none. That asymmetry is
 * what produces the three row states below.
 *
 * See docs/plans/2026-08-18-002-design-paired-worktree-branch-focus.md.
 */

/** `Worktree.branch` is not always a branch name — `listWorktrees` substitutes
 *  these when `git worktree list --porcelain` emits no `branch` line. None of
 *  them may be printed to the user as if it named a branch. */
export function isBranchSentinel(branch: string): boolean {
  return (
    branch.startsWith("detached@") || branch === "(bare)" || branch === "(unknown)"
  );
}

/**
 * How a branch row relates to the working target.
 *
 * `current` is unique across the whole window — only the repo owning the
 * working target can have one. `occupied` is per-repo and may appear in every
 * expanded repo at once; without that split the sidebar would look like it had
 * a dozen simultaneous selections.
 */
export type BranchFocusState = "current" | "occupied" | "free";

export function branchFocusState(
  branch: LocalBranchSummary,
  focusedWorktree: Worktree | null
): BranchFocusState {
  if (focusedWorktree !== null && focusedWorktree.branch === branch.name) {
    return "current";
  }
  return branch.checkedOutWorktreeIds.length > 0 ? "occupied" : "free";
}

/**
 * The worktree a branch row's chip names, or null when nothing holds it.
 *
 * Prefer a holder that is not the working target: when a branch is somehow
 * listed as checked out in the focused worktree while that worktree reports a
 * different branch, the refs snapshot is stale, and the *other* holder is the
 * one worth naming.
 */
export function holderWorktreeId(
  branch: LocalBranchSummary,
  focusedWorktreeId: WorktreeId | null
): WorktreeId | null {
  const ids = branch.checkedOutWorktreeIds;
  return ids.find((id) => id !== focusedWorktreeId) ?? ids[0] ?? null;
}

/** The chip must not repeat the branch name — branch↔worktree is 1:1, so
 *  labelling a worktree by its branch says nothing the row does not already
 *  say. Its path basename is the only distinguishing thing it carries, and it
 *  tells the user where on disk the checkout lives. */
export function worktreeLabel(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s !== "");
  return segments[segments.length - 1] ?? path;
}

/**
 * What activating a branch row does — "make this branch the one I am working
 * on", by the cheapest safe route. Two of the three answers run no git at all.
 *
 * `reveal` covers a branch already checked out somewhere: git refuses a second
 * checkout of the same branch, and the refusal teaches the user nothing they
 * wanted to know — going to that worktree is what they meant.
 */
export type BranchActivation =
  | { kind: "none" }
  | { kind: "reveal"; worktreeId: WorktreeId }
  | { kind: "switch"; branch: string };

export function branchActivation(
  branch: LocalBranchSummary,
  focusedWorktree: Worktree | null
): BranchActivation {
  if (focusedWorktree !== null && focusedWorktree.branch === branch.name) {
    return { kind: "none" };
  }
  const holder = holderWorktreeId(branch, focusedWorktree?.id ?? null);
  if (holder !== null) return { kind: "reveal", worktreeId: holder };
  return { kind: "switch", branch: branch.name };
}

/** The `· on main` suffix on the collapsed section head — the cheap 90% of the
 *  pairing, visible without expanding hundreds of rows. Null when there is
 *  nothing honest to say: no working target in this repo, or its branch is one
 *  of the sentinels. A detached checkout is worth naming as such. */
export function branchSectionSummary(
  focusedWorktree: Worktree | null
): string | null {
  if (focusedWorktree === null) return null;
  const branch = focusedWorktree.branch;
  if (branch.startsWith("detached@")) return "detached";
  if (isBranchSentinel(branch)) return null;
  return `on ${branch}`;
}

/**
 * The branches the collapsed slice shows, with the working target's branch
 * pinned first.
 *
 * Without the pin the pairing vanishes in the case that matters most: the list
 * is truncated, and only a branch that happens to sort into the first few rows
 * would ever show as current. Occupied branches are deliberately *not* pinned
 * — a repo with dozens of worktrees would fill the whole slice with them.
 */
export function visibleBranches(
  branches: readonly LocalBranchSummary[],
  focusedWorktree: Worktree | null,
  limit: number
): LocalBranchSummary[] {
  if (limit <= 0) return [];
  const currentName = focusedWorktree?.branch ?? null;
  const current =
    currentName === null
      ? undefined
      : branches.find((b) => b.name === currentName);
  if (current === undefined) return branches.slice(0, limit);
  return [
    current,
    ...branches.filter((b) => b.fullName !== current.fullName)
  ].slice(0, limit);
}
