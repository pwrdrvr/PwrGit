import type { Repo } from "@pwrgit/shared";

/**
 * Enforce single ownership of every worktree across the repo list. The current
 * schema (worktrees.id PRIMARY KEY) can't produce duplicates — but databases
 * minted by older builds could (a linked worktree indexed as its own repo, or
 * a pre-constraint table shape that survived because migrations use IF NOT
 * EXISTS). A duplicated id makes two sidebar rows claim the same selection —
 * visibly, two "selected" worktrees at once.
 *
 * The repo whose own path IS the worktree's path (its true primary) wins;
 * otherwise the first repo in list order keeps it.
 */
export function claimWorktreeOwnership(repos: Repo[]): Repo[] {
  const owner = new Map<string, string>(); // worktree id → repo id
  for (const repo of repos) {
    for (const w of repo.worktrees) {
      if (w.path === repo.path) owner.set(w.id, repo.id);
      else if (!owner.has(w.id)) owner.set(w.id, repo.id);
    }
  }
  let changed = false;
  const out = repos.map((repo) => {
    const kept = repo.worktrees.filter((w) => owner.get(w.id) === repo.id);
    if (kept.length === repo.worktrees.length) return repo;
    changed = true;
    return { ...repo, worktrees: kept };
  });
  return changed ? out : repos;
}
