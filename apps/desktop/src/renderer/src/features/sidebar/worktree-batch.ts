import { useCallback, useEffect, useState } from "react";
import type { Repo, Worktree } from "@pwrgit/shared";
import { changeRequestKeyRepoId } from "../change-request/change-request-selection";
import type { SelectionModifiers } from "./repo-view";

/**
 * The sidebar's batch (⌘/Shift-click) selection, and the rules that keep it
 * from drawing a second selection. `worktree-batch.property.test.ts` holds
 * them as a model.
 *
 * The row on screen ("viewed": App's selection, or nothing while a change
 * request is on screen) is always lit, so it is always a member of the batch
 * when the batch is in its repository. Otherwise "N selected" counts one row
 * fewer than are lit, and Remove skips a lit row.
 */
export type WorktreeBatch = {
  /** One repository's worktrees: a range needs one ordering. */
  repoId: string;
  ids: ReadonlySet<string>;
  /** The pivot for Shift-click ranges. */
  anchor: string | null;
  /** The viewed row this batch last followed. A batch follows the viewed row
   *  only when it changes, so a refresh never undoes a ⌘-click. */
  viewed: string | null;
};

const NO_IDS: ReadonlySet<string> = new Set();
export const NO_BATCH: WorktreeBatch = {
  repoId: "",
  ids: NO_IDS,
  anchor: null,
  viewed: null
};

const repoHolding = (repos: readonly Repo[], worktreeId: string): Repo | undefined =>
  repos.find((repo) => repo.worktrees.some((w) => w.id === worktreeId));

/** The worktree on screen: App's selection, unless a change request has
 *  taken its place. */
export const viewedWorktree = (
  selectedWorktreeId: string | null,
  changeRequestKey: string | null
): string | null => (changeRequestKey === null ? selectedWorktreeId : null);

/** The batch that is just the viewed row, in its repository. */
function seed(viewed: string | null, repos: readonly Repo[]): WorktreeBatch {
  const repo = viewed === null ? undefined : repoHolding(repos, viewed);
  if (repo === undefined || viewed === null) return { ...NO_BATCH, viewed };
  return { repoId: repo.id, ids: new Set([viewed]), anchor: viewed, viewed };
}

/** A click on a worktree row: the next batch, and whether the click also
 *  selects the row (moves the main pane). */
export function clickWorktreeRow(
  batch: WorktreeBatch,
  click: {
    repo: Repo;
    worktreeId: string;
    modifiers: SelectionModifiers;
    /** The rows as drawn. Pinned branch rows are among them, but are not
     *  worktrees, so a range skips them. */
    orderedIds: readonly string[];
    viewed: string | null;
  }
): { batch: WorktreeBatch; select: boolean } {
  const { repo, worktreeId: id, modifiers, orderedIds } = click;
  const rows = new Set(repo.worktrees.map((w) => w.id));
  // The viewed row, when it is one of this repository's.
  const own = click.viewed !== null && rows.has(click.viewed) ? click.viewed : null;
  if (modifiers.shiftKey && batch.repoId === repo.id && batch.anchor !== null) {
    const a = orderedIds.indexOf(batch.anchor);
    const b = orderedIds.indexOf(id);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const ids = new Set(orderedIds.slice(lo, hi + 1).filter((x) => rows.has(x)));
      if (own !== null) ids.add(own);
      return { batch: { ...batch, ids }, select: false };
    }
  }
  if (modifiers.metaKey || modifiers.ctrlKey) {
    const ids = new Set(
      batch.repoId === repo.id ? batch.ids : own === null ? [] : [own]
    );
    // The viewed row stays lit whatever the batch says, so it stays counted.
    if (ids.has(id) && id !== own) ids.delete(id);
    else ids.add(id);
    return { batch: { ...batch, repoId: repo.id, ids, anchor: id }, select: false };
  }
  // A plain click selects the row, and it is the first member of the batch,
  // so a following ⌘/Shift-click extends from it.
  return {
    batch: { repoId: repo.id, ids: new Set([id]), anchor: id, viewed: id },
    select: true
  };
}

/** A right-click on a worktree row: the next batch, and the rows the menu
 *  acts on (in `orderedIds` order). */
export function contextWorktreeRow(
  batch: WorktreeBatch,
  click: {
    repo: Repo;
    worktreeId: string;
    orderedIds: readonly string[];
    viewed: string | null;
  }
): { batch: WorktreeBatch; targets: string[] } {
  const { repo, worktreeId: id, orderedIds } = click;
  if (batch.repoId === repo.id && batch.ids.has(id) && batch.ids.size > 1) {
    return { batch, targets: orderedIds.filter((x) => batch.ids.has(x)) };
  }
  // Outside the batch the menu acts on just that row, and the batch falls
  // back to the viewed row alone. The range pivot moves to the row clicked.
  const own =
    click.viewed !== null && repo.worktrees.some((w) => w.id === click.viewed)
      ? click.viewed
      : null;
  return {
    batch: {
      repoId: repo.id,
      ids: own === null ? NO_IDS : new Set([own]),
      anchor: id,
      viewed: batch.viewed
    },
    targets: [id]
  };
}

/** Drop ids that no longer exist (a batch remove, a refresh). */
export function pruneBatch(batch: WorktreeBatch, repos: readonly Repo[]): WorktreeBatch {
  if (batch.ids.size === 0 && batch.anchor === null) return batch;
  const repo = repos.find((r) => r.id === batch.repoId);
  if (repo === undefined) return { ...NO_BATCH, viewed: batch.viewed };
  const present = new Set(repo.worktrees.map((w) => w.id));
  const ids = new Set([...batch.ids].filter((id) => present.has(id)));
  const anchor =
    batch.anchor !== null && present.has(batch.anchor) ? batch.anchor : null;
  if (ids.size === batch.ids.size && anchor === batch.anchor) return batch;
  return { ...batch, ids, anchor };
}

/**
 * After the tree or the viewed row changes. Selection also moves without a
 * row click (⌘F/⌘K, an expand or an index jump selects a primary, hide moves
 * to a neighbour, a change request takes over): the batch then starts again
 * from the new viewed row, or empties for a change request. A viewed row
 * already in the batch keeps it. A change only to the tree just prunes, so a
 * refresh never undoes a ⌘-click (5a83d04 re-seeded on every refresh).
 */
export function reconcileBatch(
  batch: WorktreeBatch,
  viewed: string | null,
  repos: readonly Repo[]
): WorktreeBatch {
  const pruned = pruneBatch(batch, repos);
  if (pruned.viewed === viewed) return pruned;
  if (viewed === null) return NO_BATCH;
  // Not in this tree yet (a restored or just-created worktree): try again
  // with the next list.
  if (repoHolding(repos, viewed) === undefined) return pruned;
  if (pruned.ids.has(viewed)) return { ...pruned, viewed };
  return seed(viewed, repos);
}

/**
 * The batch selection as the sidebar holds it. `selectedWorktreeId` is App's
 * selection; `changeRequestKey` is the change request on screen, if any.
 */
export function useWorktreeBatch({
  repos,
  selectedWorktreeId,
  changeRequestKey
}: {
  repos: readonly Repo[];
  selectedWorktreeId: string | null;
  changeRequestKey: string | null;
}): {
  batch: WorktreeBatch;
  idsFor: (repoId: string) => ReadonlySet<string>;
  /** True when the click also selects the row. */
  click: (
    repo: Repo,
    worktreeId: string,
    modifiers: SelectionModifiers,
    orderedIds: readonly string[]
  ) => boolean;
  /** The rows a right-click's menu acts on. */
  context: (repo: Repo, worktreeId: string, orderedIds: readonly string[]) => string[];
  /** Back to the viewed row alone. */
  clear: () => void;
} {
  const viewed = viewedWorktree(selectedWorktreeId, changeRequestKey);
  const [batch, setBatch] = useState<WorktreeBatch>(NO_BATCH);
  useEffect(() => {
    setBatch((prev) => reconcileBatch(prev, viewed, repos));
  }, [viewed, repos]);
  const click = (
    repo: Repo,
    worktreeId: string,
    modifiers: SelectionModifiers,
    orderedIds: readonly string[]
  ): boolean => {
    const next = clickWorktreeRow(batch, { repo, worktreeId, modifiers, orderedIds, viewed });
    setBatch(next.batch);
    return next.select;
  };
  const context = (
    repo: Repo,
    worktreeId: string,
    orderedIds: readonly string[]
  ): string[] => {
    const next = contextWorktreeRow(batch, { repo, worktreeId, orderedIds, viewed });
    if (next.batch !== batch) setBatch(next.batch);
    return next.targets;
  };
  const clear = useCallback(() => setBatch(seed(viewed, repos)), [viewed, repos]);
  const idsFor = (repoId: string): ReadonlySet<string> =>
    batch.repoId === repoId ? batch.ids : NO_IDS;
  return { batch, idsFor, click, context, clear };
}

/** How a worktree row draws: the row on screen, and batch membership. */
export function worktreeRowLook(input: {
  worktreeId: string;
  selectedWorktreeId: string | null;
  changeRequestKey: string | null;
  batchIds: ReadonlySet<string>;
}): { selected: boolean; multiSelected: boolean } {
  return {
    // A change request on screen holds the selection; the worktree it will
    // return to is not drawn as selected meanwhile.
    selected:
      input.worktreeId ===
      viewedWorktree(input.selectedWorktreeId, input.changeRequestKey),
    multiSelected: input.batchIds.has(input.worktreeId)
  };
}

/** The "N selected" bar's count, or null when the bar is not drawn. */
export function selectionBarCount(batchIds: ReadonlySet<string>): number | null {
  return batchIds.size > 1 ? batchIds.size : null;
}

/** The repository that holds what is on screen: it tints in the index and
 *  draws its row as holding the selection. A change request on screen is
 *  held by its own repository, which need not be the worktree's. */
export function selectionHolder(
  repos: readonly Repo[],
  selectedWorktreeId: string | null,
  changeRequestKey: string | null
): string | null {
  if (changeRequestKey !== null) return changeRequestKeyRepoId(changeRequestKey);
  if (selectedWorktreeId === null) return null;
  return repoHolding(repos, selectedWorktreeId)?.id ?? null;
}

/** A repo row click, or a name in the index: the repository's primary
 *  worktree to select, unless the selection is already one of its own. */
export function primaryUnlessHeld(
  repo: Repo,
  selectedWorktreeId: string | null
): Worktree | null {
  if (repo.worktrees.some((w) => w.id === selectedWorktreeId)) return null;
  return repo.worktrees.find((w) => w.isPrimary) ?? repo.worktrees[0] ?? null;
}

/** Where the selection goes when `repo` leaves the list (hide, remove): the
 *  repository after it as drawn, or before it at the end. Null when the
 *  selection is not in `repo`, or there is nowhere to go. */
export function neighbourOf(
  repo: Repo,
  drawn: readonly Repo[],
  repos: readonly Repo[],
  selectedWorktreeId: string | null
): { repo: Repo; worktree: Worktree } | null {
  if (!repo.worktrees.some((w) => w.id === selectedWorktreeId)) return null;
  const list = drawn.some((r) => r.id === repo.id) ? drawn : repos;
  const at = list.findIndex((r) => r.id === repo.id);
  const next = list[at + 1] ?? list[at - 1];
  const worktree = next?.worktrees.find((w) => w.isPrimary) ?? next?.worktrees[0];
  return next !== undefined && worktree !== undefined ? { repo: next, worktree } : null;
}
