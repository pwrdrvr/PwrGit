import { createHash } from "node:crypto";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";

/** Watches the complete refs/stash reflog, not only its tip (a non-top drop
 * leaves the tip unchanged). One fingerprint is shared by every worktree in a
 * repository because refs/stash itself is repository-wide. */
export class StashWatch {
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly git: GitExec) {}

  async hasChanged(repoId: string, cwd: string): Promise<boolean> {
    const args = ["stash", "list", "--format=%H"];
    const raw = await this.git(args, cwd, NO_OPTIONAL_LOCKS);
    if (!raw.ok) return false;
    const checked = requireExit0(raw.value, args);
    if (!checked.ok) return false;
    const fingerprint = createHash("sha1")
      .update(checked.value.stdout)
      .digest("hex");
    const previous = this.fingerprints.get(repoId);
    this.fingerprints.set(repoId, fingerprint);
    // The renderer may have loaded before this watcher is first reached. Its
    // first observation therefore cannot safely be treated as an unchanged
    // baseline: an ordinary Git command may already have moved refs/stash.
    // One redundant list refresh is cheaper than preserving a stale stack.
    return previous === undefined || previous !== fingerprint;
  }
}

export function createStashAnnouncer(deps: {
  watch: StashWatch;
  /** Active worktree id -> repository identity + any checkout path in it. */
  repoOf: (worktreeId: string) => { repoId: string; path: string } | null;
  run: <T>(repoId: string, operation: () => Promise<T>) => Promise<T>;
  announce: (repoId: string) => void;
  onError: (cause: unknown) => void;
}): (worktreeId: string) => void {
  const looking = new Set<string>();
  return (worktreeId) => {
    const repo = deps.repoOf(worktreeId);
    if (repo === null || looking.has(repo.repoId)) return;
    looking.add(repo.repoId);
    void deps
      .run(repo.repoId, () => deps.watch.hasChanged(repo.repoId, repo.path))
      .then((changed) => {
        if (changed) deps.announce(repo.repoId);
      })
      .catch(deps.onError)
      .finally(() => looking.delete(repo.repoId));
  };
}
