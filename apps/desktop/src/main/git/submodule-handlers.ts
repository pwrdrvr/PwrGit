import { err } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit, type GitExec } from "./dugite";
import { inspectSubmodules } from "./submodule-inspector";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "worktree not found"
};

export function registerSubmoduleHandlers(
  bus: CommandBus,
  db: DB,
  operations: WorktreeOperationQueue,
  git: GitExec = execGit
): void {
  bus.register("submodules:list", async (req) => {
    const row = db
      .prepare("SELECT path FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string } | undefined;
    if (row === undefined) return err(notFound);
    return operations.run(req.worktreeId, () =>
      inspectSubmodules(git, row.path)
    );
  });
}
