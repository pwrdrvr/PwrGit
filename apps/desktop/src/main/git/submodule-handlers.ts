import { err } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import {
  execGit,
  execGitRecords,
  type GitExec,
  type GitRecordExec
} from "./dugite";
import { inspectSubmodules } from "./submodule-inspector";

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "worktree not found"
};

export function registerSubmoduleHandlers(
  bus: CommandBus,
  db: DB,
  git: GitExec = execGit,
  recordGit: GitRecordExec = execGitRecords
): void {
  bus.register("submodules:list", async (req) => {
    const row = db
      .prepare("SELECT path FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string } | undefined;
    if (row === undefined) return err(notFound);
    // Every Git command in the inspector is read-only and disables optional
    // locks. Do not hold the mutation queue during a potentially deep audit:
    // staging must remain responsive, and a concurrent index move can at worst
    // produce a short-lived mixed snapshot that the next event refreshes.
    return inspectSubmodules(git, recordGit, row.path);
  });
}
