import { err } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { emitEvent } from "../ipc";
import { execGit } from "./dugite";
import { ignoreDestinations } from "./ignore-discovery";
import { readRepositorySetup, saveSetupExclude, testSetupIgnorePath } from "./repository-setup";
import type { WorktreeOperationQueue } from "./worktree-operation-queue";

export function registerRepositorySetupHandlers(bus: CommandBus, db: DB, operations: WorktreeOperationQueue): void {
  const pathOf = (repoId: string): string | null => {
    const row = db.prepare("SELECT path FROM worktrees WHERE repo_id = ? AND missing = 0 ORDER BY is_primary DESC LIMIT 1").get(repoId) as { path: string } | undefined;
    return row?.path ?? null;
  };
  const missing = () => err({ kind: "repo" as const, code: "not_found", message: "Repository checkout not found" });
  bus.register("repo:setup", async ({ repoId }) => {
    const path = pathOf(repoId);
    return path === null ? missing() : operations.runRepository(repoId, () => readRepositorySetup(execGit, path));
  });
  bus.register("repo:testIgnorePath", async ({ repoId, path: testPath }) => {
    const path = pathOf(repoId);
    return path === null ? missing() : operations.runRepository(repoId, () => testSetupIgnorePath(execGit, path, testPath));
  });
  bus.register("repo:saveExclude", async ({ repoId, previous, content }) => {
    const path = pathOf(repoId);
    if (path === null) return missing();
    return operations.runRepository(repoId, async () => {
      const result = await ignoreDestinations(execGit, path);
      if (!result.ok) return result;
      const target = result.value.destinations.find((item) => item.destination === "exclude");
      if (target === undefined) return missing();
      const saved = saveSetupExclude(target.path, previous, content);
      if (saved.ok) {
        const worktrees = db.prepare("SELECT id FROM worktrees WHERE repo_id = ? AND missing = 0").all(repoId) as { id: string }[];
        for (const worktree of worktrees) emitEvent("changes:changed", { worktreeId: worktree.id });
      }
      return saved;
    });
  });
}
