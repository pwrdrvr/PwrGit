import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import { readLog } from "./git-service";
import type { WorktreeStateService } from "./worktree-state";

export function registerGraphHandlers(
  bus: CommandBus,
  db: DB,
  state: WorktreeStateService
): void {
  bus.register("graph:log", async (req) => {
    const wt = db
      .prepare("SELECT path, repo_id FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string; repo_id: string } | undefined;
    if (wt === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }

    const commits = await readLog(execGit, wt.path, req.limit ?? 200);
    if (!commits.ok) return commits;

    const def = await state.resolveDefaultBranch(wt.repo_id, wt.path);
    let branchRoot: string | null = null;
    const mb = await execGit(["merge-base", "HEAD", def.ref], wt.path);
    if (mb.ok && mb.value.exitCode === 0) {
      const hash = mb.value.stdout.trim();
      branchRoot = hash !== "" ? hash : null;
    }

    return ok({ commits: commits.value, branchRoot, defaultBranch: def.name });
  });
}
