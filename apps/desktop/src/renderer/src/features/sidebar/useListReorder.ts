import { useCallback, useRef, useState, type DragEvent } from "react";
import { dropPositionWithin, type DropPosition } from "./repo-view";

/**
 * A browser fires a synthetic `click` on the source element when a drag is
 * released. Both sidebar lists put `onClick` (select this row) on the same
 * element as `draggable`, so without a guard every reorder also swaps the main
 * pane out from under you. The window is generous on purpose: it only has to
 * outlive the click that `dragend` immediately precedes, and it expires on its
 * own, so a `dragend` that never fires can't wedge clicks off permanently.
 */
const POST_DRAG_CLICK_SUPPRESS_MS = 250;

/**
 * "No drag has ended yet." Deliberately not 0: `performance.now()` counts from
 * the document's load, so 0 reads as a drag that ended at page load and
 * suppresses every row click for the first POST_DRAG_CLICK_SUPPRESS_MS of the
 * window's life.
 */
export const NO_DRAG_ENDED = Number.NEGATIVE_INFINITY;

/**
 * Whether a click arriving at `now` is the synthetic one a drag release fires.
 * Split out from the hook so the seed above stays covered by a test — the bug
 * this guards was in the initial value, not in the comparison.
 */
export const isPostDragClickAt = (now: number, endedAt: number): boolean =>
  now - endedAt < POST_DRAG_CLICK_SUPPRESS_MS;

export type ReorderTarget = { id: string; position: DropPosition };

export type ListReorder = {
  /** The row being dragged, for dimming it. */
  dragId: string | null;
  /** The gap the drop would land in, for drawing the insertion line. */
  target: ReorderTarget | null;
  /**
   * Whether a click arriving now is the synthetic post-drag one. Callers check
   * this at the top of their row click handler and bail.
   */
  isPostDragClick: () => boolean;
  /** Drag handlers for one row. `enabled: false` yields an inert row. */
  rowProps: (
    id: string,
    enabled: boolean
  ) => {
    draggable: boolean;
    onDragStart?: (event: DragEvent) => void;
    onDragOver?: (event: DragEvent) => void;
    onDragLeave?: (event: DragEvent) => void;
    onDrop?: (event: DragEvent) => void;
    onDragEnd?: (event: DragEvent) => void;
  };
};

/**
 * Drag-to-reorder for a flat list of rows, shared by the repo list and each
 * repo's worktree list so the two gestures feel identical.
 *
 * `mime` is what keeps them from bleeding into one another: each list tags its
 * payload with its own type and ignores a drag that doesn't carry it, so a repo
 * dragged over an expanded worktree list shows no drop line there (and vice
 * versa) rather than silently reordering the wrong list.
 */
export function useListReorder({
  mime,
  canDrop,
  onCommit
}: {
  mime: string;
  /**
   * Reject a pairing before it shows a drop line. Used to keep a drag inside
   * its folder group — an indicator the drop then refuses to honor is worse
   * than no indicator at all.
   */
  canDrop?: (dragId: string, targetId: string) => boolean;
  onCommit: (dragId: string, targetId: string, position: DropPosition) => void;
}): ListReorder {
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<ReorderTarget | null>(null);
  // The id also lives in a ref because `dataTransfer.getData` is readable only
  // during `drop` on some platforms, and because a drag that starts in another
  // list must be identifiable without reading state we never set.
  const dragIdRef = useRef<string | null>(null);
  // Seeding this with 0 claimed "a drag ended at page load" and suppressed
  // every row click for the window's first POST_DRAG_CLICK_SUPPRESS_MS — long
  // enough to eat a real one, since expanding a repo the moment the sidebar
  // lists it lands right on that boundary, and it failed silently because a
  // suppressed click is indistinguishable from one that never happened.
  const endedAtRef = useRef(NO_DRAG_ENDED);

  const clear = useCallback(() => {
    dragIdRef.current = null;
    setDragId(null);
    setTarget(null);
  }, []);

  const isPostDragClick = useCallback(
    () => isPostDragClickAt(performance.now(), endedAtRef.current),
    []
  );

  const rowProps = useCallback(
    (id: string, enabled: boolean) => {
      if (!enabled) return { draggable: false };
      return {
        draggable: true,
        onDragStart: (event: DragEvent): void => {
          dragIdRef.current = id;
          setDragId(id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(mime, id);
          // text/plain as well, so a drop onto an unrelated target degrades to
          // a harmless text drag instead of nothing at all.
          event.dataTransfer.setData("text/plain", id);
        },
        onDragOver: (event: DragEvent): void => {
          // Only claim drags from this list. `types` is the one part of
          // dataTransfer readable during dragover — the values are not.
          if (!event.dataTransfer.types.includes(mime)) return;
          const dragged = dragIdRef.current;
          if (dragged === null || dragged === id) return;
          if (canDrop !== undefined && !canDrop(dragged, id)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const position = dropPositionWithin(
            event.currentTarget.getBoundingClientRect(),
            event.clientY
          );
          setTarget((current) =>
            current?.id === id && current.position === position
              ? current
              : { id, position }
          );
        },
        onDragLeave: (event: DragEvent): void => {
          // Moving onto a child fires dragleave on the row; only drop the
          // indicator when the pointer has actually left the row's box.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setTarget((current) => (current?.id === id ? null : current));
        },
        onDrop: (event: DragEvent): void => {
          if (!event.dataTransfer.types.includes(mime)) return;
          event.preventDefault();
          event.stopPropagation();
          const dragged = dragIdRef.current ?? event.dataTransfer.getData(mime);
          const position =
            target?.id === id
              ? target.position
              : dropPositionWithin(
                  event.currentTarget.getBoundingClientRect(),
                  event.clientY
                );
          if (
            dragged !== "" &&
            dragged !== id &&
            (canDrop === undefined || canDrop(dragged, id))
          ) {
            onCommit(dragged, id, position);
          }
          endedAtRef.current = performance.now();
          clear();
        },
        onDragEnd: (): void => {
          endedAtRef.current = performance.now();
          clear();
        }
      };
    },
    [mime, canDrop, onCommit, target, clear]
  );

  return { dragId, target, isPostDragClick, rowProps };
}
