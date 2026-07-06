import { err, ok } from "@pwrgit/shared";
import { agentStatus } from "../ai/agent-discovery";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import type { CommitIdentity } from "./git-service";
import { applyRebase, planRebase, validateSelection } from "./rebase-assistant";
import type { WorktreeRefresher } from "./worktree-handlers";

export function registerRebaseHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher
): void {
  bus.register("agent:status", () => ok(agentStatus()));

  bus.register("rebase:draft", async (req) => {
    const row = db
      .prepare("SELECT path FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string } | undefined;
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    const plan = planRebase(req.commits, req.op);
    if (!plan.valid) return ok(plan);
    const valid = await validateSelection(execGit, row.path, req.commits);
    if (!valid.ok) return ok({ ...plan, valid: false, reason: valid.error.message });
    return ok(plan);
  });

  bus.register("rebase:apply", async (req) => {
    const row = db
      .prepare(
        `SELECT w.path AS path, p.email AS email, p.author_name AS author_name
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | { path: string; email: string; author_name: string | null }
      | undefined;
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    const identity: CommitIdentity =
      row.author_name !== null
        ? { email: row.email, name: row.author_name }
        : { email: row.email };
    const result = await applyRebase(
      execGit,
      row.path,
      req.commits,
      req.op,
      identity
    );
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });
}
