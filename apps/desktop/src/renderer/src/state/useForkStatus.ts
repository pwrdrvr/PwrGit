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
 * Null while loading, on a failed read, and for a checkout with no fork
 * source — the header has nothing to say in any of them.
 */
export function useForkStatus(
  worktreeId: string,
  repoId: string
): ForkStatus | null {
  const [status, setStatus] = useState<ForkStatus | null>(null);

  useEffect(() => {
    let active = true;
    let request = 0;
    setStatus(null);
    const load = (): void => {
      const mine = ++request;
      void dispatch("remote:forkStatus", { worktreeId }).then((result) => {
        // Only the newest read lands: an older one resolving late would put
        // back the count a sync just cleared.
        if (!active || mine !== request) return;
        setStatus(result.ok ? result.value : null);
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
  }, [worktreeId, repoId]);

  return status;
}
