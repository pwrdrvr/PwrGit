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
      // Compute the reconciled family before the command completes so Recent
      // sorting does not strand that row at the bottom as "undated".
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

  bus.register("repo:search", (req) => ok(indexer.searchAll(req.query)));
}
