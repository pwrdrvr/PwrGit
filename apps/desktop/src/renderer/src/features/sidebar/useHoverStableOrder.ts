import { useCallback, useReducer, useRef } from "react";
import type { DragEventHandler, PointerEventHandler } from "react";
import { retainOrder } from "./hover-stable-order";

/**
 * Hold a list's row order while the pointer is resting on it.
 *
 * A lens answers a question — "what am I working on" — and acting on the
 * answer changes it. Selecting a worktree makes its repo `current`, which is
 * rank 0 of the Focus ladder, so the row the user just clicked leaves from
 * under the cursor and every row between its old and new home shifts. The
 * list is right and the interaction is wrong: it re-sorts itself in response
 * to being read, and the next click lands on whatever slid into that spot.
 *
 * So the order keeps being computed exactly as before — this only delays when
 * a newer one becomes *visible*. While the pointer is over the rows the frozen
 * order holds and newcomers append at the bottom; moving the pointer off the
 * list reveals the newest order in one render. PwrAgnt's navigation sidebar
 * holds its rows the same way, for the same reason.
 *
 * `context` is the ordering input held alongside the ids, so a section
 * computed further down the tree from the same inputs (a repo's focused
 * worktrees) freezes and thaws with the list it is rendered inside, instead of
 * re-partitioning under a pointer the outer list is holding still for.
 *
 * `scope` is the identity of the list being held — switching lens is a new
 * question, so its answer is shown at once rather than merged into the old
 * one. `release` does the same for a change the user *made* rather than
 * observed: a drag-reorder leaves the ids untouched and only moves them, so a
 * held order would silently undo the drop.
 *
 * **`release` is only sufficient because the caller's write is optimistic.**
 * `dragend` fires `pointerover` with no user movement, so the hold re-freezes
 * the instant a drag ends — which is safe only while the committed order is
 * already in props by then. `useRepoTree.persistRepoOrder` applies it locally
 * before the round-trip (a `repo:changed` event never fires for an ordering
 * write), and that has to stay true: without it, the re-freeze captures the
 * pre-commit order and `retainOrder` holds the drop back until the pointer
 * leaves the tree.
 */
export function useHoverStableOrder<T>(params: {
  scope: string;
  ids: readonly string[];
  context: T;
}): {
  /** The order to render. Identical to `params.ids` unless `holding`. */
  ids: readonly string[];
  /** Whether the returned order and context are frozen rather than current. */
  holding: boolean;
  context: T;
  release: () => void;
  containerProps: {
    onPointerOver: PointerEventHandler<HTMLElement>;
    onPointerLeave: PointerEventHandler<HTMLElement>;
    onPointerCancel: PointerEventHandler<HTMLElement>;
    onDragStart: DragEventHandler<HTMLElement>;
    onDrop: DragEventHandler<HTMLElement>;
    onDragEnd: DragEventHandler<HTMLElement>;
  };
} {
  const latest = useRef({ ids: params.ids, context: params.context });
  latest.current = { ids: params.ids, context: params.context };
  const frozen = useRef<{ ids: readonly string[]; context: T }>(latest.current);
  const holding = useRef(false);
  // A drag has taken the pointer, but it has not left the list. See `dragging`
  // below for why that distinction is the whole fix.
  const dragging = useRef(false);
  const scope = useRef(params.scope);
  const [, showLatest] = useReducer((revision: number) => revision + 1, 0);

  if (scope.current !== params.scope) {
    scope.current = params.scope;
    holding.current = false;
    frozen.current = latest.current;
  }

  const release = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    // The render this schedules is the only thing that reveals the newest
    // order: the parent's props may not change at all when the pointer leaves.
    showLatest();
  }, []);

  /**
   * Starting a drag looks exactly like leaving the list, and is the opposite.
   * Chromium fires `dragstart` → `pointercancel` → `pointerout` →
   * `pointerleave` on the container the moment a row is picked up, so an
   * unguarded leave releases the hold mid-gesture and re-sorts the rows the
   * drag is aimed at — the very movement this hook exists to prevent, at the
   * one moment it is least recoverable. `dragstart` arrives first, which is
   * what makes this flag able to suppress the leave that follows it.
   *
   * The pointer is still over the list throughout, so nothing is owed on the
   * way out: `dragend` restores the pointer and immediately fires `pointerover`
   * again, re-freezing against the order the drop has by then committed.
   */
  const onPointerLeave = useCallback<PointerEventHandler<HTMLElement>>(() => {
    if (dragging.current) return;
    release();
  }, [release]);

  const onPointerOver = useCallback<PointerEventHandler<HTMLElement>>(
    (event) => {
      // A touch has no hover to rest in — it would enter and never leave.
      if (event.pointerType === "touch" || holding.current) return;
      frozen.current = latest.current;
      holding.current = true;
    },
    []
  );

  const onDragStart = useCallback<DragEventHandler<HTMLElement>>(() => {
    dragging.current = true;
  }, []);

  const onDragEnd = useCallback<DragEventHandler<HTMLElement>>(() => {
    dragging.current = false;
  }, []);

  return {
    // `params.ids` is handed straight back when nothing is held: the caller
    // built it this render and treats it as read-only, so copying it would buy
    // nothing but an allocation on every render the pointer is away.
    ids: holding.current
      ? retainOrder(frozen.current.ids, params.ids)
      : params.ids,
    holding: holding.current,
    context: holding.current ? frozen.current.context : params.context,
    release,
    containerProps: {
      onPointerOver,
      onPointerLeave,
      onPointerCancel: onPointerLeave,
      onDragStart,
      // `dragend` always fires, so it is what actually clears the flag — a row's
      // own drop handler stops propagation and this one never sees it. Kept for
      // a drop that lands between rows, where nothing stops it.
      onDrop: onDragEnd,
      onDragEnd
    }
  };
}
