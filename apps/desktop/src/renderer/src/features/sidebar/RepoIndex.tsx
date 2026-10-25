import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import {
  truncatedTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  sameSpy,
  spyRepos,
  typeaheadIndex,
  type RepoBlockBox,
  type RepoSpy
} from "./repo-index";

export type RepoIndexEntry = {
  id: string;
  name: string;
  /** Holds the selected worktree: drawn in the accent, like its tree row. */
  containsSelection: boolean;
};

export type RepoIndexGroup = {
  key: string;
  /** The folder label, or null when the tree is not grouped. */
  label: string | null;
  entries: RepoIndexEntry[];
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
  onJump
}: {
  groups: RepoIndexGroup[];
  /** The tree's scrollport. */
  listRef: RefObject<HTMLDivElement | null>;
  treeId: string;
  onJump: (repoId: string) => void;
}) {
  const tip = useViewportTooltip();
  const navRef = useRef<HTMLElement | null>(null);
  const [spy, setSpy] = useState<RepoSpy>(NO_SPY);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const pointerInside = useRef(false);
  const typed = useRef<{ query: string; at: number }>({ query: "", at: 0 });

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
  // And after every render of the index itself: the lens or the groups changed.
  useLayoutEffect(measure, [measure, idsKey]);

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
    <nav
      ref={navRef}
      className="repo-index"
      aria-label="Repository index"
      onKeyDown={onKeyDown}
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
      }}
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
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={`repo-index__item${current ? " is-current" : ""}${
                      !current && inView.has(entry.id) ? " is-in-view" : ""
                    }${entry.containsSelection ? " is-selected" : ""}`}
                    data-index-id={entry.id}
                    tabIndex={entry.id === tabStop ? 0 : -1}
                    aria-controls={treeId}
                    {...(current ? { "aria-current": "location" as const } : {})}
                    onClick={() => onJump(entry.id)}
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
