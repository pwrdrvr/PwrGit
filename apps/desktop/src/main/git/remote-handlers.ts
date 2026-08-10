import { err, ok, type PwrGitError } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import {
  addRemote,
  fetchAllRemotes,
  fetchNamedRemote,
  fetchRemote,
  inspectRemoteDivergence,
  inspectRemoteReset,
  pullFastForward,
  planPushRefs,
  pushPlannedRefs,
  pushRemote,
  rebaseOntoUpstream,
  removeRemote,
  resetToRemote,
  resetToUpstream,
  updateRemote
} from "./git-service";
import type { WorktreeRefresher } from "./worktree-handlers";

const seconds = (startedAt: number): string =>
  `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

const notFound: PwrGitError = {
  kind: "repo",
  code: "not_found",
  message: "worktree not found"
};

export function registerRemoteHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher
): void {
  const worktreeOf = (
    worktreeId: string
  ): { path: string; repoId: string } | null =>
    (
      db
        .prepare("SELECT path, repo_id AS repoId FROM worktrees WHERE id = ?")
        .get(worktreeId) as
        | { path: string; repoId: string }
        | undefined
    ) ?? null;

  const pathOf = (worktreeId: string): string | null =>
    worktreeOf(worktreeId)?.path ?? null;

  const repoOf = (repoId: string): { path: string } | null => {
    const row = db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    return row === undefined ? null : { path: row.path };
  };

  // Successes log at info with path + duration; failures are already logged
  // by the command bus — together the Logs window tells the whole sync story.
  bus.register("remote:fetch", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await fetchRemote(execGit, path);
    if (!result.ok) return result;
    logMain("info", "remote", `fetched ${path} (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:fetchRepo", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const startedAt = Date.now();
    const result =
      req.remote === undefined
        ? await fetchAllRemotes(execGit, repo.path)
        : await fetchNamedRemote(execGit, repo.path, req.remote);
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `fetched ${req.remote ?? "all remotes"} for ${repo.path} (${seconds(startedAt)})`
    );
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:add", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await addRemote(execGit, repo.path, req);
    if (!result.ok) return result;
    logMain("info", "remote", `added remote ${req.name} to ${repo.path}`);
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:update", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await updateRemote(execGit, repo.path, req);
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `updated remote ${req.originalName} as ${req.name} in ${repo.path}`
    );
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:remove", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await removeRemote(execGit, repo.path, req.remote);
    if (!result.ok) return result;
    logMain("info", "remote", `removed remote ${req.remote} from ${repo.path}`);
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:planPushRefs", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await planPushRefs(
      execGit,
      repo.path,
      req.sourceRef,
      req.destinations
    );
    refresher.refreshRepoWorktrees(req.repoId);
    return result;
  });

  bus.register("remote:pushRefs", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const startedAt = Date.now();
    const result = await pushPlannedRefs(execGit, repo.path, req.plans);
    refresher.refreshRepoWorktrees(req.repoId);
    if (!result.ok) return result;
    const pushed = result.value.filter((item) => item.outcome === "pushed").length;
    logMain(
      "info",
      "remote",
      `pushed ${pushed}/${result.value.length} reviewed refs for ${repo.path} (${seconds(startedAt)})`
    );
    return result;
  });

  bus.register("remote:pull", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await pullFastForward(execGit, path);
    if (result.ok) {
      const { stashed, reappliedWithConflicts } = result.value;
      const outcome = reappliedWithConflicts
        ? "fast-forwarded, stash reapplied WITH CONFLICTS"
        : stashed
          ? "fast-forwarded, stashed changes reapplied"
          : "fast-forwarded";
      logMain("info", "remote", `pulled ${path}: ${outcome} (${seconds(startedAt)})`);
      refresher.refreshWorktree(req.worktreeId);
    }
    return result;
  });

  bus.register("remote:push", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await pushRemote(execGit, path);
    if (!result.ok) return result;
    logMain("info", "remote", `pushed ${path} (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:inspectDivergence", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return inspectRemoteDivergence(execGit, path);
  });

  bus.register("remote:resetToUpstream", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await resetToUpstream(execGit, path, req);
    if (!result.ok) return result;
    logMain("info", "remote", `reset ${path} to upstream (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:inspectReset", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return inspectRemoteReset(execGit, path, req.remoteRef);
  });

  bus.register("remote:resetToRemote", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    const startedAt = Date.now();
    const result = await resetToRemote(execGit, worktree.path, req, req.mode);
    // A failed hard reset can still have touched the checkout before a file
    // operation failed. The moved branch may also be the repository default,
    // which changes every sibling's derived staleness/merge relationships.
    // Recompute the repository once for both outcomes.
    refresher.refreshRepoWorktrees(worktree.repoId);
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `${req.mode}-reset ${worktree.path} (${req.branch}) to ${req.remoteRef} at ${req.remoteHead} (${seconds(startedAt)})`
    );
    return ok(null);
  });

  bus.register("remote:rebaseOntoUpstream", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await rebaseOntoUpstream(execGit, path, req);
    // A stopped rebase changes the checkout too; refresh so the Changes panel
    // and sync badges show the conflict state immediately.
    refresher.refreshWorktree(req.worktreeId);
    if (!result.ok) return result;
    logMain("info", "remote", `rebased ${path} onto upstream (${seconds(startedAt)})`);
    return ok(null);
  });
}
