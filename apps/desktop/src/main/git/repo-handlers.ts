import { err, ok, type Profile } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { ProfileService } from "../profiles/profile-service";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";

export function registerRepoHandlers(
  bus: CommandBus,
  indexer: RepoIndexer,
  profiles: ProfileService,
  refresher: WorktreeRefresher,
  /**
   * Settings → General → Search all profiles. Read per search rather than
   * captured, so toggling it takes effect on the next keystroke. Tests and the
   * E2E fixture omit it and get the shipped default.
   */
  searchAllProfiles: () => boolean = () => false
): void {
  bus.register("repo:list", (req) => {
    const profileId = req.profileId ?? profiles.getActiveId();
    if (profileId === null) return ok([]);
    return ok(indexer.listRepos(profileId));
  });

  bus.register("repo:refreshWorktrees", async (req) => {
    const result = await indexer.refreshRepoWorktrees(req.repoId);
    if (!result.ok) return result;
    if (result.value.outcome === "reconciled") {
      // A newly discovered worktree has no cached activity timestamp yet.
      // Compute the reconciled family before the command completes so Focused
      // can rank a newly discovered worktree by its durable branch activity.
      await refresher.refreshRepoWorktrees(req.repoId);
    } else {
      // Deindexing leaves no worktrees to compute, but the deleted repo row
      // still needs to disappear from this profile's tree.
      emitEvent("repo:changed", { profileId: result.value.profileId });
    }
    return result;
  });

  // Add/remove scan roots all rescan the profile and return the fresh repo list.
  const rescanAfter = async (
    profileId: string,
    mutate: () => Profile | null
  ) => {
    const profile = mutate();
    if (profile === null) {
      return err({
        kind: "profile" as const,
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    const repos = await indexer.rescanProfile(profile);
    // Roots changed → refresh both the profile list and the repo tree.
    emitEvent("profile:changed", profiles.snapshot());
    emitEvent("repo:changed", { profileId: profile.id });
    return ok(repos);
  };

  bus.register("profile:setRoots", (req) =>
    rescanAfter(req.profileId, () => profiles.setRoots(req.profileId, req.roots))
  );

  bus.register("repo:setPin", (req) => {
    indexer.setRepoPinned(req.repoId, req.pinned);
    const profileId = profiles.getActiveId();
    if (profileId !== null) emitEvent("repo:changed", { profileId });
    return ok(null);
  });

  bus.register("worktree:setPin", (req) => {
    indexer.setWorktreePinned(req.worktreeId, req.pinned);
    const profileId = profiles.getActiveId();
    if (profileId !== null) emitEvent("repo:changed", { profileId });
    return ok(null);
  });

  // The asking window names its own profile; `repo:list`'s fallback covers a
  // request that did not. Both null only when no profile exists at all, and
  // then there is nothing indexed to scope to either.
  bus.register("repo:search", (req) =>
    ok(
      indexer.searchAll(req.query, {
        profileId: req.profileId ?? profiles.getActiveId(),
        allProfiles: searchAllProfiles()
      })
    )
  );

  // Shared across visible hits, searches and windows. Keep in-flight work in
  // the cache too: three rows from one repository cost one worktree listing.
  // Cache failures briefly as well so an unavailable disk cannot cause a storm.
  const listings = new Map<string, {
    expiresAt: number;
    pending: ReturnType<RepoIndexer["refreshRepoWorktrees"]>;
  }>();
  bus.register("search:branchWorktree", async (req) => {
    const now = Date.now();
    for (const [repoId, entry] of listings) {
      if (entry.expiresAt <= now) listings.delete(repoId);
    }
    let entry = listings.get(req.repoId);
    if (entry === undefined) {
      const pending = indexer.refreshRepoWorktrees(req.repoId, {
        refreshBranches: false
      }).then((result) => {
        if (result.ok) {
          const value = result.value;
          if (value.outcome === "deindexed") {
            emitEvent("repo:changed", { profileId: value.profileId });
          } else if (value.added || value.removed || value.updated) {
            emitEvent("repo:changed", { profileId: value.repo.profileId });
          }
        }
        return result;
      });
      entry = { expiresAt: Infinity, pending };
      listings.set(req.repoId, entry);
      const created = entry;
      void pending.then(
        () => { created.expiresAt = Date.now() + 30_000; },
        () => { listings.delete(req.repoId); }
      );
    }
    const result = await entry.pending;
    if (!result.ok) return result;
    const repo = indexer.getRepo(req.repoId);
    if (repo === null) {
      return err({ kind: "repo", code: "not_found", message: "repo not found" });
    }
    const worktree = repo.worktrees.find((wt) => wt.branch === req.branch);
    if (worktree === undefined) return ok(null);
    return ok({
      kind: "worktree" as const,
      repoId: repo.id,
      repoName: repo.name,
      name: worktree.branch,
      path: worktree.path,
      worktreeId: worktree.id,
      profileId: repo.profileId,
      profileName: profiles.get(repo.profileId)?.name ?? "",
      pinned: worktree.pinned,
      worktreeCount: 0,
      ...(worktree.pr !== undefined ? { pr: worktree.pr } : {})
    });
  });
}
