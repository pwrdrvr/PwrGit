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
 * would otherwise rescan the profile every time it looked. An ask that lands
 * while that profile is already scanning does not start the cooldown: the
 * running scan may have listed the folder before it went, so the next probe
 * has to be free to ask again.
 */
export function createMissingRepoRescan({
  profileOf,
  rescan,
  now = Date.now,
  cooldownMs = MISSING_REPO_RESCAN_COOLDOWN_MS
}: {
  /** The profile a repository belongs to, or null once its row is gone. */
  profileOf: (repoId: string) => string | null;
  /** Rescan one profile, past the throttle. False when none started. */
  rescan: (profileId: string) => boolean;
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
    if (rescan(profileId)) asked.set(repoId, at);
  };
}

export const MISSING_REPO_RESCAN_COOLDOWN_MS = 10 * 60_000;
