import { useCallback, useReducer, useRef } from "react";
import type { PointerEventHandler } from "react";
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
 */
export function useHoverStableOrder<T>(params: {
  scope: string;
  ids: readonly string[];
  context: T;
}): {
  ids: string[];
  context: T;
  release: () => void;
  containerProps: {
    onPointerOver: PointerEventHandler<HTMLElement>;
    onPointerLeave: PointerEventHandler<HTMLElement>;
    onPointerCancel: PointerEventHandler<HTMLElement>;
  };
} {
  const latest = useRef({ ids: params.ids, context: params.context });
  latest.current = { ids: params.ids, context: params.context };
  const frozen = useRef<{ ids: readonly string[]; context: T }>(latest.current);
  const holding = useRef(false);
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

  const onPointerOver = useCallback<PointerEventHandler<HTMLElement>>(
    (event) => {
      // A touch has no hover to rest in — it would enter and never leave.
      if (event.pointerType === "touch" || holding.current) return;
      frozen.current = latest.current;
      holding.current = true;
    },
    []
  );

  return {
    ids: holding.current
      ? retainOrder(frozen.current.ids, params.ids)
      : [...params.ids],
    context: holding.current ? frozen.current.context : params.context,
    release,
    containerProps: {
      onPointerOver,
      onPointerLeave: release,
      onPointerCancel: release
    }
  };
}
