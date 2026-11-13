import type { Profile } from "@pwrgit/shared";

/** A routine look at every profile's roots, while the app runs. */
export const ROOT_DISCOVERY_INTERVAL_MS = 2 * 60_000;
/** A window coming forward looks too, but not more often than this. */
export const ROOT_DISCOVERY_FOCUS_GAP_MS = 30_000;
/**
 * The same new folders ask again only after this long. A completed scan
 * records every folder it walked, so they stop being new; they stay new
 * only while scans fail, and a failing scan must not run every tick.
 */
export const ROOT_DISCOVERY_RETRY_MS = 10 * 60_000;

/**
 * Keep a running app's profiles in step with their roots.
 *
 * A full rescan runs Git in every repository, so `shouldRescanProfile` holds
 * it to once a day, and until this existed the only routine caller was a
 * profile window opening. A repository cloned into a root while PwrGit ran
 * stayed out of the sidebar, ⌘K included, until the next window opened a day
 * after the last scan.
 *
 * Each check walks every profile's roots (milliseconds, no Git) and asks for a
 * scan when that walk found a repository folder the last scan did not
 * (`unscannedRepoDirs`, forced past the throttle), or when the daily scan is
 * due. Like `missing-repo-rescan.ts`, this moves WHEN a scan runs, never
 * what it may prune.
 */
export function createRootDiscovery({
  profiles,
  indexer,
  rescan,
  onFound,
  now = Date.now,
  retryMs = ROOT_DISCOVERY_RETRY_MS
}: {
  profiles: () => readonly Profile[];
  indexer: {
    shouldRescanProfile(profileId: string): boolean;
    unscannedRepoDirs(profile: Profile): Promise<string[]>;
  };
  /** Start a scan of one profile. False when none started (one is running). */
  rescan: (profile: Profile, options: { force: boolean }) => boolean;
  /** A forced scan started for these folders (for the log). */
  onFound?: (profile: Profile, dirs: readonly string[]) => void;
  now?: () => number;
  retryMs?: number;
}): {
  /** Look now, unless a look is running or one started within `minGapMs`. */
  check(options?: { minGapMs?: number }): Promise<void>;
} {
  const asked = new Map<string, { key: string; at: number }>();
  let running = false;
  let lastStart = Number.NEGATIVE_INFINITY;

  const checkProfile = async (profile: Profile): Promise<void> => {
    if (indexer.shouldRescanProfile(profile.id)) {
      rescan(profile, { force: false });
      return;
    }
    const dirs = await indexer.unscannedRepoDirs(profile);
    if (dirs.length === 0) {
      asked.delete(profile.id);
      return;
    }
    const key = dirs.join("\0");
    const last = asked.get(profile.id);
    if (last !== undefined && last.key === key && now() - last.at < retryMs) {
      return;
    }
    // A scan already running may have walked before these folders arrived,
    // so a refusal is not an answer: leave `asked` alone and look again.
    if (rescan(profile, { force: true })) {
      asked.set(profile.id, { key, at: now() });
      onFound?.(profile, dirs);
    }
  };

  return {
    async check({ minGapMs = 0 } = {}) {
      const at = now();
      if (running || at - lastStart < minGapMs) return;
      running = true;
      lastStart = at;
      try {
        for (const profile of profiles()) {
          if (profile.roots.length === 0) continue;
          // One unreadable profile must not stop the others being looked at.
          await checkProfile(profile).catch(() => undefined);
        }
      } finally {
        running = false;
      }
    }
  };
}
