import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Where the sidebar stood when a place was left: the row the reader last
 * acted on (or scrolled with), and how far below the top of the list it sat.
 * Restored by row key, not by pixel, because lists above it change height
 * while you are away — a disclosure opens, a PR lands. When the row is gone
 * the sidebar falls back to revealing the selected worktree, as it always has.
 */
export type SidebarAnchor = {
  key: string;
  offset: number;
};

/**
 * One place in the window's Back/Forward history: a worktree selection. The
 * open commit and the sidebar anchor ride on the entry rather than becoming
 * entries of their own, so clicking down the lineage does not bury the
 * worktree you came from under thirty commit stops.
 */
export type NavigationLocation = {
  repoId: string;
  worktreeId: string;
  commit?: { hash: string; subject: string };
  anchor?: SidebarAnchor;
  /** When the place was left, for the history menu. */
  leftAt?: number;
};

/** What is captured from the window as a place is left. */
export type NavigationRiders = Pick<NavigationLocation, "commit" | "anchor">;

export type NavigationStacks = {
  back: NavigationLocation[];
  /** The place on screen now. Holds its spot while nothing is selected, so
   *  selecting the same worktree again records no hop. */
  cursor: NavigationLocation | undefined;
  forward: NavigationLocation[];
};

/** Per-stack depth cap, PwrAgnt's. */
export const MAX_HISTORY_DEPTH = 50;

const EMPTY: NavigationStacks = { back: [], cursor: undefined, forward: [] };

const samePlace = (a: NavigationLocation, b: NavigationLocation): boolean =>
  a.worktreeId === b.worktreeId;

/** The cursor as it is left. Its riders are the ones captured now, never the
 *  ones it was restored with: a commit closed since then must stay closed. */
const leave = (
  cursor: NavigationLocation,
  leaving: NavigationRiders & { leftAt: number }
): NavigationLocation => ({
  repoId: cursor.repoId,
  worktreeId: cursor.worktreeId,
  ...leaving
});

function append(
  stack: NavigationLocation[],
  location: NavigationLocation
): NavigationLocation[] {
  const top = stack[stack.length - 1];
  if (top !== undefined && samePlace(top, location)) {
    // Same place twice in a row: keep the newer riders.
    return [...stack.slice(0, -1), location];
  }
  return [...stack, location].slice(-MAX_HISTORY_DEPTH);
}

/** Drop entries whose worktree is gone, then collapse the neighbours the
 *  removal leaves adjacent (A, dead, A → A). Same array when nothing goes. */
function prune(
  stack: NavigationLocation[],
  live: ReadonlySet<string>
): NavigationLocation[] {
  const kept = stack.filter((location) => live.has(location.worktreeId));
  if (kept.length === stack.length) return stack;
  const collapsed: NavigationLocation[] = [];
  for (const location of kept) {
    const top = collapsed[collapsed.length - 1];
    if (top !== undefined && samePlace(top, location)) continue;
    collapsed.push(location);
  }
  return collapsed;
}

/** Leave the cursor for `target`: the pure half of goBack, goForward and a
 *  jump from the history menu. `steps` counts from the nearest entry, 1 for
 *  a plain Back. Undefined when the stack is not that deep. */
export function stepHistory(
  stacks: NavigationStacks,
  direction: "back" | "forward",
  steps: number,
  leaving: NavigationRiders & { leftAt: number }
): { next: NavigationStacks; target: NavigationLocation } | undefined {
  const here =
    stacks.cursor === undefined ? undefined : leave(stacks.cursor, leaving);
  if (direction === "back") {
    const index = stacks.back.length - steps;
    const target = stacks.back[index];
    if (target === undefined || steps < 1) return undefined;
    // Everything stepped over moves to Forward, nearest first, the way a
    // browser's long-press menu leaves the rest of the stack in place.
    const skipped = stacks.back.slice(index + 1);
    return {
      target,
      next: {
        back: stacks.back.slice(0, index),
        cursor: target,
        forward: [
          ...skipped,
          ...(here === undefined ? [] : [here]),
          ...stacks.forward
        ].slice(0, MAX_HISTORY_DEPTH)
      }
    };
  }
  const index = steps - 1;
  const target = stacks.forward[index];
  if (target === undefined || steps < 1) return undefined;
  const skipped = stacks.forward.slice(0, index);
  let back = here === undefined ? stacks.back : append(stacks.back, here);
  for (const location of skipped) back = append(back, location);
  return {
    target,
    next: { back, cursor: target, forward: stacks.forward.slice(index + 1) }
  };
}

/** Record that the window now shows `current`. Same stacks when it already
 *  did — that is also how a restore is told apart from a new navigation. */
export function recordNavigation(
  stacks: NavigationStacks,
  current: NavigationLocation,
  leaving: NavigationRiders & { leftAt: number }
): NavigationStacks {
  const cursor = stacks.cursor;
  if (cursor !== undefined && samePlace(cursor, current)) {
    // A restore lands here with the target already the cursor. Keep its
    // recorded commit and anchor; the repo id is the only thing to refresh.
    return cursor.repoId === current.repoId
      ? stacks
      : { ...stacks, cursor: { ...cursor, repoId: current.repoId } };
  }
  return {
    back:
      cursor === undefined
        ? stacks.back
        : append(stacks.back, leave(cursor, leaving)),
    cursor: { repoId: current.repoId, worktreeId: current.worktreeId },
    forward: []
  };
}

export function pruneNavigation(
  stacks: NavigationStacks,
  live: ReadonlySet<string>
): NavigationStacks {
  const back = prune(stacks.back, live);
  const forward = prune(stacks.forward, live);
  const cursor =
    stacks.cursor !== undefined && live.has(stacks.cursor.worktreeId)
      ? stacks.cursor
      : undefined;
  if (
    back === stacks.back &&
    forward === stacks.forward &&
    cursor === stacks.cursor
  ) {
    return stacks;
  }
  return { back, cursor, forward };
}

const STORAGE_PREFIX = "pwrgit.navigationHistory.";

function isLocation(value: unknown): value is NavigationLocation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["repoId"] === "string" &&
    typeof candidate["worktreeId"] === "string"
  );
}

/** One window is one profile, and the selection is already saved per
 *  profile; the history is saved beside it so Back survives a relaunch. */
export function readStoredNavigation(profileId: string | null): NavigationStacks {
  if (profileId === null) return EMPTY;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${profileId}`);
    if (raw === null) return EMPTY;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const list = (value: unknown): NavigationLocation[] =>
      Array.isArray(value)
        ? value.filter(isLocation).slice(-MAX_HISTORY_DEPTH)
        : [];
    return {
      back: list(parsed["back"]),
      cursor: isLocation(parsed["cursor"]) ? parsed["cursor"] : undefined,
      forward: list(parsed["forward"])
    };
  } catch {
    // Unavailable storage or an older build's malformed value: start empty.
    return EMPTY;
  }
}

function storeNavigation(profileId: string, stacks: NavigationStacks): void {
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${profileId}`,
      JSON.stringify(stacks)
    );
  } catch {
    // Best-effort, like the selection it sits beside.
  }
}

export type NavigationHistory = {
  stacks: NavigationStacks;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Step `steps` entries back (1 = Back). */
  goBack: (steps?: number) => void;
  goForward: (steps?: number) => void;
};

/**
 * Browser-style history over the window's worktree selection, ported from
 * PwrAgnt's `useNavigationHistory`. It OBSERVES the selection instead of
 * asking every jump to push — sidebar click, PR row, ⌘K, lineage chip, tag
 * Locate, clone — so a new way to navigate is recorded without touching it.
 *
 * `restore` must synchronously set the state `current` derives from; the
 * cursor moves first, so the resulting change reads as the restore it is and
 * is not recorded again. `capture` is asked for the leaving place's riders
 * (open commit, sidebar anchor) at the moment it is left.
 */
export function useNavigationHistory(args: {
  profileId: string | null;
  current: { repoId: string; worktreeId: string } | null;
  restore: (location: NavigationLocation) => void;
  capture: () => NavigationRiders;
  /** Worktree ids the window knows about. Undefined while repos load, so an
   *  empty first answer cannot wipe the history. */
  liveWorktreeIds: ReadonlySet<string> | undefined;
}): NavigationHistory {
  const { profileId } = args;
  const [stacks, setStacksState] = useState<NavigationStacks>(() =>
    readStoredNavigation(profileId)
  );
  // Read synchronously by the stable callbacks below, which would otherwise
  // close over a stale render's stacks.
  const stacksRef = useRef(stacks);
  const callbacks = useRef({ restore: args.restore, capture: args.capture });
  useEffect(() => {
    callbacks.current = { restore: args.restore, capture: args.capture };
  });

  const setStacks = useCallback(
    (next: NavigationStacks) => {
      if (next === stacksRef.current) return;
      stacksRef.current = next;
      setStacksState(next);
      if (profileId !== null) storeNavigation(profileId, next);
    },
    [profileId]
  );

  const repoId = args.current?.repoId;
  const worktreeId = args.current?.worktreeId;
  useEffect(() => {
    if (repoId === undefined || worktreeId === undefined) return;
    const leaving = {
      ...callbacks.current.capture(),
      leftAt: Date.now()
    };
    setStacks(
      recordNavigation(stacksRef.current, { repoId, worktreeId }, leaving)
    );
  }, [repoId, setStacks, worktreeId]);

  const live = args.liveWorktreeIds;
  useEffect(() => {
    if (live === undefined) return;
    setStacks(pruneNavigation(stacksRef.current, live));
  }, [live, setStacks]);

  const step = useCallback(
    (direction: "back" | "forward", steps: number) => {
      const result = stepHistory(stacksRef.current, direction, steps, {
        ...callbacks.current.capture(),
        leftAt: Date.now()
      });
      if (result === undefined) return;
      setStacks(result.next);
      callbacks.current.restore(result.target);
    },
    [setStacks]
  );
  const goBack = useCallback((steps = 1) => step("back", steps), [step]);
  const goForward = useCallback((steps = 1) => step("forward", steps), [step]);

  return useMemo(
    () => ({
      stacks,
      canGoBack: stacks.back.length > 0,
      canGoForward: stacks.forward.length > 0,
      goBack,
      goForward
    }),
    [goBack, goForward, stacks]
  );
}
