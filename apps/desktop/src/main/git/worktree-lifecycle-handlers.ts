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
import type { WorktreeStateService } from "./worktree-state";

const slugBranch = (branch: string): string => branch.replace(/\//g, "-");

export function registerWorktreeLifecycleHandlers(
  bus: CommandBus,
  db: DB,
  indexer: RepoIndexer,
  settings: SettingsService,
  state: WorktreeStateService
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

  bus.register("worktree:removeMany", async (req) => {
    type Row = {
      path: string;
      is_primary: number;
      repo_id: string;
      repo_path: string;
      profile_id: string;
    };
    const stmt = db.prepare(
      `SELECT w.path AS path, w.is_primary AS is_primary,
              r.id AS repo_id, r.path AS repo_path, r.profile_id AS profile_id
       FROM worktrees w JOIN repos r ON r.id = w.repo_id
       WHERE w.id = ?`
    );

    const removed: string[] = [];
    const dirty: string[] = [];
    const failed: { id: string; message: string }[] = [];
    const affectedRepos = new Set<string>();
    const affectedProfiles = new Set<string>();

    // Remove sequentially — concurrent `git worktree remove` in one repo would
    // race on .git/worktrees. Dozens of removes is still fast.
    const releases: (() => void)[] = [];
    try {
      for (const id of req.worktreeIds) {
        const wt = stmt.get(id) as Row | undefined;
        if (wt === undefined) {
          failed.push({ id, message: "worktree not found" });
          continue;
        }
        if (wt.is_primary === 1) {
          failed.push({ id, message: "Can't remove the primary worktree" });
          continue;
        }
        // Windows can't delete a directory that is any process's cwd, and a
        // state probe runs a chain of git commands with cwd inside the
        // worktree — so block probes for this worktree (and drain running
        // ones) before removing it. Held until the batch's indexer refresh
        // drops the DB rows, so no probe spawns git in a deleted directory.
        releases.push(await state.lockForRemoval(id));
        const res = await worktreeRemove(execGit, wt.repo_path, wt.path, {
          force: req.force ?? false
        });
        if (res.ok) {
          removed.push(id);
          affectedRepos.add(wt.repo_id);
          affectedProfiles.add(wt.profile_id);
          // Stream each removal so the sidebar prunes the row live — a batch of
          // dozens can take a while (each deletes the whole working tree).
          emitEvent("worktree:removed", { worktreeId: id });
        } else if (res.error.code === "dirty") {
          dirty.push(id);
        } else {
          failed.push({ id, message: res.error.message });
        }
      }

      for (const repoId of affectedRepos) {
        await indexer.refreshRepoWorktrees(repoId);
      }
    } finally {
      for (const release of releases) release();
    }
    for (const profileId of affectedProfiles) {
      emitEvent("repo:changed", { profileId });
    }
    return ok({ removed, dirty, failed });
  });

  bus.register("worktree:setOrder", (req) => {
    indexer.setWorktreeOrder(req.repoId, req.orderedWorktreeIds);
    return ok(null);
  });
}
