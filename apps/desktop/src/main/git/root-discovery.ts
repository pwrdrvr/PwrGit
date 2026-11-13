import type { Profile } from "@pwrgit/shared";

/**
 * The fallback look while the app runs. Every Fetch/Pull run (yours or the
 * timer's) also looks first, so this matters only with automatic sync off;
 * it is the authored-commit sweep's cadence.
 */
export const ROOT_DISCOVERY_INTERVAL_MS = 15 * 60_000;
/**
 * How long a request that did not settle waits before asking again: the same
 * new folders (a scan records every folder it could resolve, so they stay new
 * only while Git cannot read them) or a daily scan that cannot finish (an
 * unreadable root never stamps the scan clock). Doubles per repeat, up to a
 * day, so neither turns every Fetch into a full rescan.
 */
export const ROOT_DISCOVERY_RETRY_MS = 10 * 60_000;
const RETRY_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * Keep a running app's profiles in step with their roots.
 *
 * A full rescan runs Git in every repository, so `shouldRescanProfile` holds
 * it to once a day, and until this existed the only routine caller was a
 * profile window opening. A repository cloned into a root while PwrGit ran
 * stayed out of the sidebar, ⌘K included, until the next window opened a day
 * after the last scan.
 *
 * A check runs shortly after launch, at the start of every Fetch/Pull run
 * (that profile only) and every 15 minutes. It
 * walks every profile's roots (milliseconds, no Git) and asks for a scan when
 * that walk found a repository folder the last scan did not
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
  /**
   * Look now at one profile, or all. A call while a look runs is not lost:
   * that look runs once more over every profile when it finishes.
   */
  check(profileId?: string): Promise<void>;
} {
  type Ask = { key: string; at: number; tries: number };
  const asked = new Map<string, Ask>();
  let running = false;
  let again = false;

  const due = (last: Ask | undefined, key: string): boolean =>
    last === undefined ||
    last.key !== key ||
    now() - last.at >= Math.min(retryMs * 2 ** (last.tries - 1), RETRY_CAP_MS);
  const remember = (id: string, key: string): void => {
    const last = asked.get(id);
    asked.set(id, {
      key,
      at: now(),
      tries: last !== undefined && last.key === key ? last.tries + 1 : 1
    });
  };

  const checkProfile = async (profile: Profile): Promise<void> => {
    const dailyKey = `${profile.id}\0daily`;
    if (indexer.shouldRescanProfile(profile.id)) {
      // Still due after a scan that ran means it cannot finish (a root that
      // cannot be read); back off rather than rescan every Fetch.
      if (due(asked.get(dailyKey), "daily")) {
        if (rescan(profile, { force: false })) remember(dailyKey, "daily");
        return;
      }
    } else {
      asked.delete(dailyKey);
    }
    const dirs = await indexer.unscannedRepoDirs(profile);
    if (dirs.length === 0) {
      asked.delete(profile.id);
      return;
    }
    const key = dirs.join("\0");
    if (!due(asked.get(profile.id), key)) return;
    // A scan already running may have walked before these folders arrived,
    // so a refusal is not an answer: leave `asked` alone and look again.
    if (rescan(profile, { force: true })) {
      remember(profile.id, key);
      onFound?.(profile, dirs);
    }
  };

  return {
    async check(profileId) {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        let only = profileId;
        do {
          again = false;
          for (const profile of profiles()) {
            if (profile.roots.length === 0) continue;
            if (only !== undefined && profile.id !== only) continue;
            // One unreadable profile must not stop the others being looked at.
            await checkProfile(profile).catch(() => undefined);
          }
          only = undefined;
        } while (again);
      } finally {
        running = false;
      }
    }
  };
}
