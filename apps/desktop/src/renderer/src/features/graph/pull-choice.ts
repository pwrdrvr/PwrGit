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
