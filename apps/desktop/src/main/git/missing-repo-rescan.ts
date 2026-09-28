/**
 * When a repository's own folder disappears, ask for a profile rescan now
 * rather than waiting out `shouldRescanProfile`'s day-long throttle.
 *
 * This moves WHEN the scan runs, never WHAT it may delete. `rescanProfile`
 * keeps every guard it has: it prunes only `source = 'scan'` rows, and only
 * when every root was readable and some repository still resolved
 * (`canPruneFromScan`). An unmounted volume is exactly as safe as before.
 * A repository added by hand is never pruned, so it stays flagged missing —
 * which is why each repository asks at most once per cooldown: the 15s poll
 * would otherwise rescan the profile every time it looked.
 */
export function createMissingRepoRescan({
  profileOf,
  rescan,
  now = Date.now,
  cooldownMs = MISSING_REPO_RESCAN_COOLDOWN_MS
}: {
  /** The profile a repository belongs to, or null once its row is gone. */
  profileOf: (repoId: string) => string | null;
  /** Rescan one profile, past the throttle. */
  rescan: (profileId: string) => void;
  now?: () => number;
  cooldownMs?: number;
}): (repoId: string) => void {
  const asked = new Map<string, number>();
  return (repoId) => {
    const at = now();
    const last = asked.get(repoId);
    if (last !== undefined && at - last < cooldownMs) return;
    const profileId = profileOf(repoId);
    if (profileId === null) return;
    asked.set(repoId, at);
    rescan(profileId);
  };
}

export const MISSING_REPO_RESCAN_COOLDOWN_MS = 10 * 60_000;
