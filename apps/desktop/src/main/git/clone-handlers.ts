import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { CloneService } from "./clone-service";

export function registerCloneHandlers(
  bus: CommandBus,
  clones: CloneService
): void {
  bus.register("repo:cloneCatalog", (req) => clones.catalog(req.profileId));
  bus.register("repo:checkCloneSource", (req) =>
    clones.checkSource(req.profileId, req.nameWithOwner)
  );
  bus.register("repo:clone", async (req) => {
    const result = await clones.clone(req);
    if (result.ok) emitEvent("repo:changed", { profileId: req.profileId });
    return result;
  });
}
