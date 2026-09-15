import { err, ok, type Profile } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { mapLimit } from "../util/map-limit";
import type { ProfileService } from "../profiles/profile-service";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";

export function registerRepoHandlers(
  bus: CommandBus,
  indexer: RepoIndexer,
  profiles: ProfileService,
  refresher: WorktreeRefresher
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

  bus.register("repo:search", async (req) => {
    const hits = indexer.searchAll(req.query);
    // Another process can create a checkout or switch its branch after the
    // last scan. Verify cached "no worktree" claims against Git before the
    // palette offers to create one. Only probe repositories behind those hits,
    // once per repository, and never compute status for their whole family.
    const repoIds = [
      ...new Set(
        hits.filter((hit) => hit.kind === "local_branch").map((hit) => hit.repoId)
      )
    ];
    if (repoIds.length === 0) return ok(hits);
    const refreshed: Awaited<ReturnType<RepoIndexer["refreshRepoWorktrees"]>>[] = [];
    await mapLimit(repoIds, 4, async (repoId) => {
      refreshed.push(await indexer.refreshRepoWorktrees(repoId));
    });
    const profilesChanged = new Set<string>();
    for (const result of refreshed) {
      if (!result.ok) continue;
      const value = result.value;
      if (value.outcome === "deindexed") {
        profilesChanged.add(value.profileId);
      } else if (value.added > 0 || value.removed > 0 || value.updated > 0) {
        profilesChanged.add(value.repo.profileId);
      }
    }
    // Publish newly discovered rows so selecting the search hit can reveal it
    // in the sidebar, including when the checkout lives outside scan roots.
    for (const profileId of profilesChanged) {
      emitEvent("repo:changed", { profileId });
    }
    const failed = refreshed.find((result) => !result.ok);
    if (failed !== undefined && !failed.ok) return failed;
    return ok(indexer.searchAll(req.query));
  });
}
