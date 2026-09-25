import { useSyncExternalStore } from "react";

/**
 * "Show me this repository in the sidebar" — asked from outside the sidebar.
 *
 * Selection alone cannot answer it. Selecting a worktree is what expands and
 * scrolls a repo into view, but only when the selection CHANGES: a toast about
 * the repository you are already in would otherwise be a chip that does
 * nothing, however far the row has been scrolled or collapsed away. And the
 * remote half has no selection to ride at all — which remotes are open is
 * `RepoRefsSections`' own state.
 *
 * So the request is a small store, not an event. The repo row, and the refs
 * sections inside it, mount only once the repo is expanded, and the remote row
 * only once `repo:refs` has answered; a request posted before any of that must
 * still be there for them to pick up. Whoever finishes it calls
 * `settleSidebarReveal`, and a newer request replaces an unfinished one — a
 * reveal the user has moved on from must never go off later on its own.
 */
export type SidebarReveal = {
  /** Distinguishes two requests for the same target: clicking the same chip
   *  twice is two asks, and the second must scroll again. */
  seq: number;
  repoId: string;
  /** A remote to open and scroll to inside the repo's Remotes section, or
   *  null for the repo row itself. */
  remote: string | null;
};

let current: SidebarReveal | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function requestSidebarReveal(
  repoId: string,
  remote: string | null = null
): void {
  seq += 1;
  current = { seq, repoId, remote };
  notify();
}

/** Done, or cannot be done — either way nothing should act on it again. A
 *  stale `seq` is a no-op, so finishing an old request never clears a newer
 *  one. */
export function settleSidebarReveal(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): SidebarReveal | null {
  return current;
}

export function useSidebarReveal(): SidebarReveal | null {
  return useSyncExternalStore(subscribe, snapshot);
}
