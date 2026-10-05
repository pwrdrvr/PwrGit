import type { PrRefreshTrigger } from "./pr-service";

/**
 * Re-ask the forge about branches whose upstream just went gone while their
 * cached change request still reads open.
 *
 * Gone is evidence: a remote branch is deleted, almost always, because its
 * pull request merged. Without this, the sidebar row said "gone" beside a
 * green open chip for up to the repo sweep's ten minutes — the PR's state
 * lagging the ref's by exactly that TTL.
 *
 * A repo expand probes every worktree at once, so the asks are collected per
 * repository for one tick and sent as a single branch batch. The transition
 * itself asks at the user tier (10s throttle); a branch that simply stays gone
 * with an open PR — a fork's head, say — asks at the scheduled tier, whose
 * one-minute TTL keeps the active worktree's poll from re-asking every tick.
 */
export function createGonePrRefresh(
  refresh: (
    repoId: string,
    branches: string[],
    trigger: PrRefreshTrigger
  ) => Promise<void>,
  delayMs = 250
): {
  queue: (repoId: string, branch: string, firstSeen: boolean) => void;
  stop: () => void;
} {
  const pending = new Map<
    string,
    { branches: Set<string>; firstSeen: boolean }
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A probe can still land during quit, after the handlers it would call
  // have stopped.
  let stopped = false;

  const flush = (): void => {
    timer = undefined;
    const batches = [...pending];
    pending.clear();
    for (const [repoId, batch] of batches) {
      void refresh(
        repoId,
        [...batch.branches],
        batch.firstSeen ? "user" : "scheduled"
      ).catch(() => {
        // Best-effort: the next probe of a still-gone branch asks again.
      });
    }
  };

  return {
    queue: (repoId, branch, firstSeen) => {
      if (stopped) return;
      const batch = pending.get(repoId) ?? {
        branches: new Set<string>(),
        firstSeen: false
      };
      batch.branches.add(branch);
      batch.firstSeen ||= firstSeen;
      pending.set(repoId, batch);
      timer ??= setTimeout(flush, delayMs);
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    }
  };
}
