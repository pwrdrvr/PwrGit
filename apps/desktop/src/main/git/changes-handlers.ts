import { err } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import { readChanges } from "./git-service";

export function registerChangesHandlers(bus: CommandBus, db: DB): void {
  bus.register("changes:list", async (req) => {
    const wt = db
      .prepare("SELECT path FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string } | undefined;
    if (wt === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    return readChanges(execGit, wt.path);
  });
}
