import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { ProfileService } from "../profiles/profile-service";
import type { RepoIndexer } from "./repo-indexer";

export function registerRepoHandlers(
  bus: CommandBus,
  indexer: RepoIndexer,
  profiles: ProfileService
): void {
  bus.register("repo:list", (req) => {
    const profileId = req.profileId ?? profiles.getActiveId();
    if (profileId === null) return ok([]);
    return ok(indexer.listRepos(profileId));
  });

  bus.register("repo:rescan", async (req) => {
    const profileId = req.profileId ?? profiles.getActiveId();
    if (profileId === null) return ok([]);
    const profile = profiles.get(profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    const repos = await indexer.rescanProfile(profile);
    emitEvent("repo:changed", { profileId });
    return ok(repos);
  });

  bus.register("repo:add", async (req) => {
    const result = await indexer.indexRepoAt(req.profileId, req.path);
    if (result.ok) emitEvent("repo:changed", { profileId: req.profileId });
    return result;
  });

  bus.register("profile:addRoot", async (req) => {
    const profile = profiles.addRoot(req.profileId, req.root);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    const repos = await indexer.rescanProfile(profile);
    emitEvent("repo:changed", { profileId: profile.id });
    return ok(repos);
  });

  bus.register("repo:search", (req) => ok(indexer.searchAll(req.query)));
}
