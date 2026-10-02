import { useEffect, useState } from "react";
import type { ForkStatus } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

/**
 * The checked-out branch against its counterpart on the fork's source, kept
 * fresh the way `useWorktreeState` keeps the sync counts. Both events are
 * needed: a fast-forward moves this worktree (`worktree:changed`), but a fetch
 * that moves only the source's tip leaves the worktree's own state exactly as
 * it was, and repaints the repository instead (`graph:changed`).
 *
 * `undefined` until the first read for this checkout and branch lands — the
 * header paints from the stored `worktree.source` meanwhile, the same count
 * the sidebar draws, so a fork's chip and Pull's arrow are there from the
 * first frame instead of arriving under the pointer (Post-ship 2c). Null on a
 * failed read and for a checkout with no fork source — the header has nothing
 * to say in either. A later re-read keeps the previous answer on screen until
 * it resolves; only a change of checkout or branch goes back to `undefined`.
 */
export function useForkStatus(
  worktreeId: string,
  repoId: string,
  branch: string
): ForkStatus | null | undefined {
  const key = `${worktreeId}\0${branch}`;
  const [read, setRead] = useState<{
    key: string;
    status: ForkStatus | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    let request = 0;
    const load = (): void => {
      const mine = ++request;
      void dispatch("remote:forkStatus", { worktreeId }).then((result) => {
        // Only the newest read lands: an older one resolving late would put
        // back the count a sync just cleared.
        if (!active || mine !== request) return;
        setRead({ key, status: result.ok ? result.value : null });
      });
    };
    load();
    const offWorktree = subscribe("worktree:changed", (payload) => {
      if (payload.worktreeId === worktreeId) load();
    });
    const offGraph = subscribe("graph:changed", (payload) => {
      if (payload.repoId === repoId) load();
    });
    return () => {
      active = false;
      offWorktree();
      offGraph();
    };
  }, [key, worktreeId, repoId]);

  // A read from the previous selection is not an answer about this one.
  if (read === null || read.key !== key) return undefined;
  const { status } = read;
  // Main answered for a branch the checkout has since left: still waiting.
  if (status !== null && status.branch !== branch) return undefined;
  return status;
}
