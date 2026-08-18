import { createHash } from "node:crypto";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";

/**
 * Notices that a worktree's change set moved for reasons PwrGit did not cause.
 *
 * The worktree refresher compares coarse state — dirty count, head,
 * ahead/behind — and that count is a lossy summary of the list. Adding
 * `dist/` to a .gitignore takes the change set from 20,000 files to one and
 * leaves the count at 1 → 1: git collapses the untracked directory to a single
 * `? dist/` entry, and the new .gitignore replaces it one-for-one. Nothing in
 * the coarse state moves, so `worktree:changed` never fires and the Changes
 * list keeps showing files that are now ignored.
 *
 * So compare the status output itself. It is only run for the worktree the
 * user is looking at, and it is cheap even when the answer is enormous:
 * `-uall` across 20,000 untracked files measured ~40ms.
 */
export class ChangeSetWatch {
  /** One hex digest per worktree ever looked at. Nothing prunes it: a
   *  worktree id is never reused, so a stale entry can only ever be dead
   *  weight, and the weight is one short string per worktree. */
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly git: GitExec) {}

  /**
   * Re-read the worktree's status and report whether the change set differs
   * from the last look. The first look for a worktree seeds the fingerprint
   * and reports `false` — there is nothing yet to have changed from.
   */
  async hasChanged(worktreeId: string, cwd: string): Promise<boolean> {
    const raw = await this.git(
      ["status", "--porcelain=v2", "--untracked-files=all"],
      cwd,
      NO_OPTIONAL_LOCKS
    );
    if (!raw.ok) return false;
    const checked = requireExit0(raw.value, ["status"]);
    if (!checked.ok) return false;

    const fingerprint = createHash("sha1")
      .update(checked.value.stdout)
      .digest("hex");
    const previous = this.fingerprints.get(worktreeId);
    this.fingerprints.set(worktreeId, fingerprint);
    return previous !== undefined && previous !== fingerprint;
  }

}

/**
 * Glue for the active-worktree poll: look, and announce when the list moved.
 * Fire-and-forget by design — the caller is a timer tick, not a request — so
 * it takes its own error sink rather than handing back a promise nobody awaits.
 */
export function createChangeSetAnnouncer(deps: {
  watch: ChangeSetWatch;
  /** Worktree id → checkout path, or null when the row is gone. */
  pathOf: (worktreeId: string) => string | null;
  /** The per-worktree operation queue, so a look cannot race a mutation. */
  run: <T>(worktreeId: string, operation: () => Promise<T>) => Promise<T>;
  announce: (worktreeId: string) => void;
  onError: (cause: unknown) => void;
}): (worktreeId: string) => void {
  // Triggers arrive faster than looks complete: the poll ticks every 15s, and
  // every window focus fires one too. The operation queue chains rather than
  // coalescing, so without this an alt-tab flurry — or any tick landing while
  // a long pull holds the queue — buys a status read per trigger, all of them
  // after the first guaranteed to see the same fingerprint. One outstanding
  // look per worktree is enough; the next trigger reads the state this one
  // would have.
  const looking = new Set<string>();
  return (worktreeId) => {
    const path = deps.pathOf(worktreeId);
    if (path === null || looking.has(worktreeId)) return;
    looking.add(worktreeId);
    void deps
      .run(worktreeId, () => deps.watch.hasChanged(worktreeId, path))
      .then((changed) => {
        if (changed) deps.announce(worktreeId);
      })
      .catch(deps.onError)
      .finally(() => looking.delete(worktreeId));
  };
}
