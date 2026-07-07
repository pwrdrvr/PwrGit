import { ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { getGhStatus } from "./pr-client";
import type { PrService } from "./pr-service";

export function registerGitHubHandlers(bus: CommandBus, prs: PrService): void {
  bus.register("pr:refresh", async (req) => {
    const changed = await prs.refreshRepo(req.repoId, {
      force: req.force ?? false
    });
    if (changed.size > 0) {
      // Targeted delta — the renderer patches these branches' PRs onto the tree
      // in place, no full repo:list reload.
      emitEvent("pr:changed", {
        repoId: req.repoId,
        prs: Object.fromEntries(changed)
      });
    }
    return ok(null);
  });

  bus.register("github:status", async () => ok(await getGhStatus()));
}
