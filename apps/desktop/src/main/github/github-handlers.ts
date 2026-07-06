import { ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import { getGhStatus } from "./pr-client";
import type { PrService } from "./pr-service";

export function registerGitHubHandlers(
  bus: CommandBus,
  prs: PrService,
  db: DB
): void {
  bus.register("pr:refresh", async (req) => {
    const changed = await prs.refreshRepo(req.repoId, {
      force: req.force ?? false
    });
    if (changed) {
      const repo = db
        .prepare("SELECT profile_id FROM repos WHERE id = ?")
        .get(req.repoId) as { profile_id: string } | undefined;
      if (repo !== undefined) {
        emitEvent("repo:changed", { profileId: repo.profile_id });
      }
    }
    return ok(null);
  });

  bus.register("github:status", async () => ok(await getGhStatus()));
}
