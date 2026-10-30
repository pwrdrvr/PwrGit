/**
 * What Pull does on a fork branch the source also carries, remembered per
 * repository. The arrow beside Pull is where it is picked, and picking a row
 * runs it as well as keeping it.
 *
 * - `sync` — fast-forward from the source, then push the same commits on to
 *   the tracked branch. The default: on a fork, the default branch mirrors
 *   the source, and the tracked branch just follows along.
 * - `source` — the fast-forward alone; the tracked branch waits for Push.
 * - `tracked` — Pull as it is everywhere else: the branch the checkout tracks.
 */
export type PullChoice = "sync" | "source" | "tracked";

export const PULL_CHOICE_DEFAULT: PullChoice = "sync";

const storageKey = (repoId: string): string => `pwrgit.pullChoice.${repoId}`;

function isPullChoice(value: string | null): value is PullChoice {
  return value === "sync" || value === "source" || value === "tracked";
}

export function readPullChoice(repoId: string): PullChoice {
  try {
    const raw = window.localStorage.getItem(storageKey(repoId));
    return isPullChoice(raw) ? raw : PULL_CHOICE_DEFAULT;
  } catch {
    return PULL_CHOICE_DEFAULT;
  }
}

export function writePullChoice(repoId: string, choice: PullChoice): void {
  try {
    if (choice === PULL_CHOICE_DEFAULT) {
      window.localStorage.removeItem(storageKey(repoId));
    } else {
      window.localStorage.setItem(storageKey(repoId), choice);
    }
  } catch {
    // A blocked storage partition costs the memory of the choice, nothing else.
  }
}

/**
 * The answer to "this fork has moved on from its original", asked once per
 * repository in the Pull card that first shows it.
 *
 * - `tracked` — the fork is its own project now: Pull brings in only what the
 *   fork's own branch has. Work from the original arrives another way (for
 *   PwrDisk, an agent ports upstream pull requests one by one), so the Pull
 *   menu stops offering to rebase onto it or reset to it.
 * - `sync` — keep syncing from the original; asked and declined, so not asked
 *   again.
 * Design: `design/Tracking Another Remote - UX Review.dc.html`, turn 4.
 */
export type MovedOnAnswer = "tracked" | "sync";

const movedOnKey = (repoId: string): string => `pwrgit.forkMovedOn.${repoId}`;

export function readMovedOnAnswer(repoId: string): MovedOnAnswer | null {
  try {
    const raw = window.localStorage.getItem(movedOnKey(repoId));
    return raw === "tracked" || raw === "sync" ? raw : null;
  } catch {
    return null;
  }
}

export function writeMovedOnAnswer(repoId: string, answer: MovedOnAnswer): void {
  try {
    window.localStorage.setItem(movedOnKey(repoId), answer);
  } catch {
    // As above: the question comes back, nothing else is lost.
  }
}

/**
 * Whether the fork's own branch has moved on from the original: the branch
 * has everything the original has, so has the fork's tracked branch, and the
 * fork's branch has commits the original lacks. A sync then fast-forwards
 * nothing and has nothing it could push.
 */
export function forkMovedOn(source: {
  behind: number;
  pushBack: { adds: number; overwrites: number } | null;
}): boolean {
  return (
    source.behind === 0 &&
    source.pushBack !== null &&
    source.pushBack.adds === 0 &&
    source.pushBack.overwrites > 0
  );
}
