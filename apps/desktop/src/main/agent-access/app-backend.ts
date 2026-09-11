import { ok, err } from "@pwrgit/shared";
import type { AppBackend, AppCatalog } from "@pwrgit/mcp-server";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import type { RepoIndexer } from "../git/repo-indexer";
import type { ProfileService } from "../profiles/profile-service";

type Navigation = { selectedWorktreeId: string | null; visits: Record<string, number> };
export function createAppBackend(db: DB, profiles: ProfileService, indexer: RepoIndexer, bus: CommandBus): AppBackend {
  const key = (profileId: string) => `profile:${profileId}:navigation`;
  const read = (profileId: string): Navigation => {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key(profileId)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Navigation : { selectedWorktreeId: null, visits: {} };
  };
  bus.register("navigation:record", request => {
    if (!profiles.get(request.profileId)) return err({ kind: "validation", code: "unknown_profile", message: "Unknown profile" });
    const known = new Set(indexer.listRepos(request.profileId).flatMap(repo => repo.worktrees.map(w => w.id)));
    if (request.selectedWorktreeId !== null && !known.has(request.selectedWorktreeId)) return err({ kind: "validation", code: "unknown_worktree", message: "Unknown worktree" });
    const state = read(request.profileId);
    // Import existing localStorage history once a profile window is opened.
    // Accept only known worktrees, finite past dates and a bounded input.
    const now = Date.now();
    for (const [id, at] of Object.entries(request.visits ?? {}).slice(0, 400)) {
      if (known.has(id) && Number.isFinite(at) && at >= 0 && at <= now) state.visits[id] = Math.max(state.visits[id] ?? 0, at);
    }
    if (request.selectedWorktreeId !== null) state.visits[request.selectedWorktreeId] = now;
    state.selectedWorktreeId = request.selectedWorktreeId;
    state.visits = Object.fromEntries(Object.entries(state.visits).filter(([id]) => known.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 400));
    db.prepare("INSERT INTO app_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key(request.profileId), JSON.stringify(state));
    return ok(null);
  });
  return {
    catalog(): AppCatalog {
      const snapshot = profiles.snapshot();
      return {
        activeProfileId: profiles.getActiveId(),
        profiles: snapshot.profiles.map(profile => ({ id: profile.id, name: profile.name, roots: profile.roots })),
        repositories: snapshot.profiles.flatMap(profile => {
          const navigation = read(profile.id);
          return indexer.listRepos(profile.id).map(repo => ({
            id: repo.id, profileId: profile.id, name: repo.name, path: repo.path, pinned: repo.pinned,
            worktrees: repo.worktrees.map(worktree => ({
              id: worktree.id, path: worktree.path, branch: worktree.branch,
              pinned: worktree.pinned, isPrimary: worktree.isPrimary, missing: worktree.missing ?? false,
              selected: navigation.selectedWorktreeId === worktree.id,
              lastViewedAt: navigation.visits[worktree.id] === undefined ? null : new Date(navigation.visits[worktree.id]!).toISOString(),
              lastCommitAt: worktree.lastActivityAt ?? null,
              dirty: worktree.dirty, ahead: worktree.ahead, behind: worktree.behind
            }))
          }));
        })
      };
    },
    async open(repo, worktreeId) {
      const result = await bus.dispatch("profile:openWindow", { profileId: repo.profileId, revealRepoId: repo.id,
        ...(worktreeId ? { revealWorktreeId: worktreeId } : {}) });
      if (!result.ok) throw new Error(result.error.message);
    },
    async refresh(repo) {
      const result = await bus.dispatch("repo:refreshWorktrees", { repoId: repo.id });
      if (!result.ok) throw new Error(result.error.message);
    }
  };
}
