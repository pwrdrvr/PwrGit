import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { PaneResizer } from "../shell/PaneResizer";
import {
  truncatedTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  clampRepoIndexWidth,
  repoIndexItemClass,
  readRepoIndexWidth,
  sameSpy,
  spyRepos,
  typeaheadIndex,
  writeRepoIndexWidth,
  type RepoBlockBox,
  type RepoSpy
} from "./repo-index";
import type { ListReorder, ReorderTarget } from "./useListReorder";

export type RepoIndexEntry = {
  id: string;
  name: string;
  /** Holds what is on screen (`selectionHolder`: the selected worktree, or
   *  the change request shown): drawn in the accent, like its tree row. */
  containsSelection: boolean;
};

export type RepoIndexGroup = {
  key: string;
  /** The folder label, or null when the tree is not grouped. */
  label: string | null;
  entries: RepoIndexEntry[];
};

/**
 * Moving names, as the tree's repo rows move: the same drag (one
 * `useListReorder`, so held and aimed state shows in both views and a name
 * can land on a tree row) and the same ⌘⇧↑/↓. Passed only while the lens is
 * arranged by hand. Design: `design/Repo Index Reorder - UX Review.dc.html`.
 */
export type RepoIndexReorder = {
  rowProps: (id: string) => ReturnType<ListReorder["rowProps"]>;
  dragId: string | null;
  target: ReorderTarget | null;
  isPostDragClick: () => boolean;
  /** The move a key asks for (⌘⇧↑/↓, Ctrl off the Mac), or null. */
  moveKey: (event: ReactKeyboardEvent) => "up" | "down" | null;
  /** Move one step inside its folder group. False when it cannot move. */
  onMove: (id: string, direction: "up" | "down") => boolean;
};

const NO_SPY: RepoSpy = { current: null, inView: [] };
/** How long typed letters keep building one typeahead query. */
const TYPEAHEAD_MS = 600;

/** Read the tree's repository blocks, in px from the list's top edge. The
 *  block (not its sticky header) is measured: a stuck header reports where it
 *  is stuck, not where its repository is. */
function measureBlocks(list: HTMLElement): RepoBlockBox[] {
  const top = list.getBoundingClientRect().top;
  const boxes: RepoBlockBox[] = [];
  for (const row of list.querySelectorAll<HTMLElement>(".repo-row[data-repo-id]")) {
    const id = row.dataset["repoId"];
    if (id === undefined) continue;
    const rect = (row.closest(".repo-block") ?? row).getBoundingClientRect();
    boxes.push({ id, top: rect.top - top, bottom: rect.bottom - top });
  }
  return boxes;
}

/** The sticky folder heading's height when grouped: the line a repository's
 *  header sticks under, and the top of the readable area. */
export function stickyLineOf(list: HTMLElement): number {
  const head = list.querySelector<HTMLElement>(".repo-group__head");
  return head === null ? 0 : head.getBoundingClientRect().height;
}

/**
 * The name-only column beside the repository tree.
 *
 * It owns its scroll-spy state, so a scroll re-renders this column and not
 * the whole sidebar. A jump is the parent's job (it owns expand state); this
 * only says which repository was asked for.
 */
export function RepoIndex({
  groups,
  listRef,
  treeId,
  onJump,
  reorder
}: {
  groups: RepoIndexGroup[];
  /** The tree's scrollport. */
  listRef: RefObject<HTMLDivElement | null>;
  treeId: string;
  onJump: (repoId: string) => void;
  reorder?: RepoIndexReorder;
}) {
  const tip = useViewportTooltip();
  const navRef = useRef<HTMLElement | null>(null);
  const [spy, setSpy] = useState<RepoSpy>(NO_SPY);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const pointerInside = useRef(false);
  const typed = useRef<{ query: string; at: number }>({ query: "", at: 0 });
  // A name moved by ⌘⇧↑/↓, until its new place renders. React reorders by
  // moving <li>s, and Chromium drops focus from a node it moves.
  const movedRef = useRef<string | null>(null);

  // ---- Width: natural until dragged ----
  // The grip is the shell's own PaneResizer. Its bounds are read back from
  // the column's computed min-width (the 7ch probe rule) and max-width (the
  // sidebar's width past the tree's floor), so a drag can never push the
  // tree below the width it is built for. Double-click returns to natural.
  const [dragged, setDragged] = useState<number | null>(readRepoIndexWidth);
  const [box, setBox] = useState({ width: 0, min: 0, max: 0 });
  const readBox = useCallback((): { width: number; min: number; max: number } => {
    const nav = navRef.current;
    if (nav === null) return { width: 0, min: 0, max: 0 };
    const style = getComputedStyle(nav);
    const min = parseFloat(style.minWidth) || 0;
    const max = parseFloat(style.maxWidth);
    return {
      width: nav.getBoundingClientRect().width,
      min,
      max: Number.isFinite(max) ? max : min
    };
  }, []);
  const syncBox = useCallback((): void => {
    const next = readBox();
    setBox((prev) =>
      prev.width === next.width && prev.min === next.min && prev.max === next.max
        ? prev
        : next
    );
  }, [readBox]);
  useLayoutEffect(syncBox, [syncBox, dragged]);
  useEffect(() => {
    const nav = navRef.current;
    if (nav === null || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(syncBox);
    observer.observe(nav);
    // The sidebar's width moves the cap (max-width) without always moving
    // the column, so watch the row it sits in too.
    if (nav.parentElement !== null) observer.observe(nav.parentElement);
    return () => observer.disconnect();
  }, [syncBox]);
  const setWidth = (raw: number | null): void => {
    const { min, max } = readBox();
    const next = raw === null ? null : clampRepoIndexWidth(raw, min, max);
    setDragged(next);
    writeRepoIndexWidth(next);
  };
  const onResizeStart = (event: ReactPointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const { width: startWidth, min, max } = readBox();
    // Null until the pointer moves: a press alone (or the first half of a
    // double-click) must not save the natural width as a dragged one.
    let last: number | null = null;
    const onMove = (move: PointerEvent): void => {
      last = clampRepoIndexWidth(startWidth + move.clientX - startX, min, max);
      setDragged(last);
    };
    const onUp = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-col-resizing");
      if (last !== null) writeRepoIndexWidth(last);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.body.classList.add("is-col-resizing");
  };

  const entries = groups.flatMap((group) => group.entries);
  const ids = entries.map((entry) => entry.id);
  const idsKey = ids.join("\n");

  const measure = useCallback((): void => {
    const list = listRef.current;
    if (list === null) return;
    const next = spyRepos(measureBlocks(list), list.clientHeight, stickyLineOf(list));
    setSpy((prev) => (sameSpy(prev, next) ? prev : next));
  }, [listRef]);

  // Follow the tree: on scroll (one read per frame), and whenever the tree
  // changes height under a still scroll position — a repository opening or
  // closing, a section loading.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    const tree = document.getElementById(treeId);
    const resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(onScroll) : null;
    resize?.observe(list);
    if (tree !== null) resize?.observe(tree);
    return () => {
      window.cancelAnimationFrame(frame);
      list.removeEventListener("scroll", onScroll);
      resize?.disconnect();
    };
  }, [listRef, measure, treeId]);
  // And when the lens or the folder groups change what is listed.
  useLayoutEffect(measure, [measure, idsKey]);

  // Focus follows a name moved from the keyboard.
  useLayoutEffect(() => {
    const moved = movedRef.current;
    const nav = navRef.current;
    if (moved === null || nav === null) return;
    movedRef.current = null;
    const item = findItem(nav, moved);
    if (item !== null && document.activeElement !== item) item.focus();
  }, [idsKey]);

  // Keep the current repository in view in the index — but never while the
  // reader is in it: an item must not move under the pointer, and a keyboard
  // walk owns the index's scroll.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav === null || spy.current === null) return;
    if (pointerInside.current || nav.contains(document.activeElement)) return;
    const item = findItem(nav, spy.current);
    if (item === null) return;
    const navRect = nav.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.top < navRect.top) nav.scrollTop += rect.top - navRect.top;
    else if (rect.bottom > navRect.bottom) nav.scrollTop += rect.bottom - navRect.bottom;
  }, [spy.current]);

  const tabStop =
    (focusedId !== null && ids.includes(focusedId) ? focusedId : null) ??
    spy.current ??
    ids[0] ??
    null;

  const focusAt = (index: number): void => {
    const id = ids[index];
    const nav = navRef.current;
    if (id === undefined || nav === null) return;
    setFocusedId(id);
    findItem(nav, id)?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    const at = ids.indexOf(target.dataset["indexId"] ?? "");
    if (at === -1) return;
    const direction = reorder?.moveKey(event) ?? null;
    if (direction !== null) {
      event.preventDefault();
      const id = ids[at] as string;
      if (reorder?.onMove(id, direction)) movedRef.current = id;
      return;
    }
    // The move chord where names don't move: unclaimed, as on the tree's
    // rows, not a plain arrow walk.
    if (event.shiftKey && (event.metaKey || event.ctrlKey)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(Math.min(at + 1, ids.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(Math.max(at - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(ids.length - 1);
    } else if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const now = Date.now();
      const query =
        now - typed.current.at > TYPEAHEAD_MS
          ? event.key
          : typed.current.query + event.key;
      typed.current = { query, at: now };
      const hit = typeaheadIndex(
        entries.map((entry) => entry.name),
        at,
        query
      );
      if (hit !== -1) {
        event.preventDefault();
        focusAt(hit);
      }
    }
  };

  const inView = new Set(spy.inView);

  return (
    <>
    <nav
      ref={navRef}
      className="repo-index"
      aria-label="Repository index"
      {...(dragged === null ? {} : { style: { width: dragged } })}
      onKeyDown={onKeyDown}
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
      }}
      // An HTML drag fires no pointer events, so a drag over the column
      // counts as the pointer being in it: the column must not scroll to
      // follow the tree under a held name.
      onDragOver={() => {
        pointerInside.current = true;
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          pointerInside.current = false;
        }
      }}
      onDragStartCapture={tip.hide}
    >
      {groups.map((group) => (
        <div className="repo-index__group" key={group.key}>
          {group.label !== null && (
            <div className="repo-index__label" aria-hidden="true">
              {group.label}
            </div>
          )}
          <ul
            className="repo-index__list"
            {...(group.label === null ? {} : { "aria-label": group.label })}
          >
            {group.entries.map((entry) => {
              const current = entry.id === spy.current;
              const cut = truncatedTooltip(tip, entry.name);
              const drop =
                reorder?.target?.id === entry.id ? reorder.target.position : null;
              return (
                <li
                  key={entry.id}
                  {...(drop === null ? {} : { className: `is-drop-${drop}` })}
                >
                  <button
                    type="button"
                    {...reorder?.rowProps(entry.id)}
                    className={repoIndexItemClass({
                      current,
                      inView: inView.has(entry.id),
                      containsSelection: entry.containsSelection,
                      dragging: reorder?.dragId === entry.id
                    })}
                    data-index-id={entry.id}
                    tabIndex={entry.id === tabStop ? 0 : -1}
                    aria-controls={treeId}
                    {...(current ? { "aria-current": "location" as const } : {})}
                    onClick={() => {
                      // The click a drag release fires is not a jump.
                      if (reorder?.isPostDragClick()) return;
                      onJump(entry.id);
                    }}
                    onMouseEnter={cut.onMouseEnter}
                    onMouseLeave={cut.onMouseLeave}
                    onFocus={(event) => {
                      setFocusedId(entry.id);
                      cut.onFocus(event);
                    }}
                    onBlur={cut.onBlur}
                  >
                    {entry.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {tip.tooltipNode}
    </nav>
    <PaneResizer
      side="left"
      offset={box.width}
      width={box.width}
      min={Math.round(box.min)}
      max={Math.round(box.max)}
      onPointerDown={onResizeStart}
      onNudge={(delta) => setWidth(readBox().width + delta)}
      onReset={() => setWidth(null)}
      ariaLabel="Resize repository index"
    />
    </>
  );
}

/** Compared, never interpolated into a selector: ids carry whatever a path
 *  hash does. */
function findItem(nav: HTMLElement, id: string): HTMLElement | null {
  for (const el of nav.querySelectorAll<HTMLElement>("[data-index-id]")) {
    if (el.dataset["indexId"] === id) return el;
  }
  return null;
}
