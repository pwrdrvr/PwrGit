import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { CloneService } from "./clone-service";

export function registerCloneHandlers(
  bus: CommandBus,
  clones: CloneService
): void {
  const active = new Map<string, AbortController>();
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
  bus.register("repo:checkLocalCloneSource", (req) =>
    clones.checkLocalSource(req.profileId, req.path)
  );
  bus.register("repo:clone", async (req) => {
    if (active.has(req.operationId)) {
      return err({
        kind: "validation",
        code: "duplicate_operation",
        message: "That clone operation is already running."
      });
    }
    const controller = new AbortController();
    active.set(req.operationId, controller);
    try {
      const result = await clones.clone(
        req,
        (progress) => {
          emitEvent("repo:cloneProgress", {
            operationId: req.operationId,
            profileId: req.profileId,
            progress
          });
        },
        controller.signal
      );
      if (result.ok) emitEvent("repo:changed", { profileId: req.profileId });
      return result;
    } finally {
      active.delete(req.operationId);
    }
  });
  bus.register("repo:cancelClone", (req) => {
    active.get(req.operationId)?.abort({
      kind: "git",
      code: "aborted",
      message: "Clone canceled."
    });
    return ok(null);
  });
}
