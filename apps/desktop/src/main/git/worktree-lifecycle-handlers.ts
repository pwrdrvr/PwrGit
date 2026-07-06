import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { SettingsService } from "../settings/settings-service";
import { execGit } from "./dugite";
import { worktreeAdd, worktreeRemove } from "./git-service";
import type { RepoIndexer } from "./repo-indexer";

const slugBranch = (branch: string): string => branch.replace(/\//g, "-");

export function registerWorktreeLifecycleHandlers(
  bus: CommandBus,
  db: DB,
  indexer: RepoIndexer,
  settings: SettingsService
): void {
  const worktreeRoot = (): string =>
    settings.get().worktreeRoot ?? join(homedir(), "wt");

  bus.register("worktree:create", async (req) => {
    const repo = db
      .prepare("SELECT id, name, path, profile_id FROM repos WHERE id = ?")
      .get(req.repoId) as
      | { id: string; name: string; path: string; profile_id: string }
      | undefined;
    if (repo === undefined) {
      return err({ kind: "repo", code: "not_found", message: "repo not found" });
    }
    const wtPath = join(worktreeRoot(), repo.name, slugBranch(req.branch));
    const added = await worktreeAdd(execGit, repo.path, wtPath, req.branch, {
      newBranch: req.newBranch
    });
    if (!added.ok) return added;
    await indexer.refreshRepoWorktrees(repo.id);
    emitEvent("repo:changed", { profileId: repo.profile_id });
    return ok(null);
  });

  bus.register("worktree:remove", async (req) => {
    const wt = db
      .prepare(
        `SELECT w.path AS path, w.is_primary AS is_primary,
                r.id AS repo_id, r.path AS repo_path, r.profile_id AS profile_id
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | {
          path: string;
          is_primary: number;
          repo_id: string;
          repo_path: string;
          profile_id: string;
        }
      | undefined;
    if (wt === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    if (wt.is_primary === 1) {
      return err({
        kind: "repo",
        code: "is_primary",
        message: "Can't remove the repo's primary worktree"
      });
    }
    const removed = await worktreeRemove(execGit, wt.repo_path, wt.path, {
      force: req.force ?? false
    });
    if (!removed.ok) return removed;
    await indexer.refreshRepoWorktrees(wt.repo_id);
    emitEvent("repo:changed", { profileId: wt.profile_id });
    return ok(null);
  });

  bus.register("worktree:setOrder", (req) => {
    indexer.setWorktreeOrder(req.repoId, req.orderedWorktreeIds);
    return ok(null);
  });
}
