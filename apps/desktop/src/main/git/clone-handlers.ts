import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { CloneService } from "./clone-service";

export function registerCloneHandlers(
  bus: CommandBus,
  clones: CloneService
): void {
  bus.register("repo:cloneCatalog", (req) => clones.catalog(req.profileId));
  bus.register("repo:cloneDestinations", (req) =>
    clones.destinations(req.profileId, req.includeNested)
  );
  bus.register("repo:searchCloneSources", (req) =>
    clones.searchSources(req.profileId, req.query, req.host)
  );
  bus.register("repo:checkCloneSource", (req) =>
    clones.checkSource(req.profileId, req.nameWithOwner, req.host)
  );
  bus.register("repo:clone", async (req) => {
    const result = await clones.clone(req, (progress) => {
      emitEvent("repo:cloneProgress", {
        operationId: req.operationId,
        profileId: req.profileId,
        progress
      });
    });
    if (result.ok) emitEvent("repo:changed", { profileId: req.profileId });
    return result;
  });
}
