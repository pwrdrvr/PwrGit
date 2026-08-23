import { err, ok, type Result } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import type { SettingsService } from "../settings/settings-service";
import { deleteLocalBranch, renameLocalBranch } from "./branch-lifecycle";
import { execGit } from "./dugite";
import {
  checkoutNewBranchAt,
  createBranchAt,
  listBranches,
  listLocalBranchNames,
  listRemoteBranchPage,
  listRepoRefs,
  readChanges,
  switchBranch,
  worktreeAdd
} from "./git-service";
import type { RepoIndexer } from "./repo-indexer";
import { worktreePathFor } from "./worktree-paths";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "worktree not found"
};

type Row = {
  path: string;
  repo_id: string;
  repo_name: string;
  repo_path: string;
  profile_id: string;
};

type RepoRow = {
  path: string;
  profile_id: string;
};

export function registerBranchHandlers(
  bus: CommandBus,
  db: DB,
  indexer: RepoIndexer,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue,
  settings: SettingsService
): void {
  const rowOf = (worktreeId: string): Row | undefined =>
    db
      .prepare(
        `SELECT w.path AS path, w.repo_id AS repo_id, r.name AS repo_name,
                r.path AS repo_path, r.profile_id AS profile_id
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as Row | undefined;

  const repoOf = (repoId: string): RepoRow | undefined =>
    db
      .prepare("SELECT path, profile_id FROM repos WHERE id = ?")
      .get(repoId) as RepoRow | undefined;

  const publishBranchMutation = async (
    repoId: string,
    profileId: string
  ): Promise<void> => {
    await indexer.refreshRepoWorktrees(repoId);
    const worktrees = db
      .prepare("SELECT id FROM worktrees WHERE repo_id = ?")
      .all(repoId) as { id: string }[];
    // A local ref moved even though no checkout did. Force every open graph of
    // this repository to invalidate its repo-level lane cache; repo:changed
    // reloads the sidebar and command-palette branch indexes separately.
    for (const worktree of worktrees) {
      emitEvent("worktree:changed", { worktreeId: worktree.id });
    }
    emitEvent("repo:changed", { profileId });
  };

  bus.register("branch:list", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return err(notFound);
    return listBranches(execGit, row.path);
  });

  bus.register("branch:localNames", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return err(notFound);
    return listLocalBranchNames(execGit, row.path);
  });

  bus.register("repo:refs", async (req) => {
    const repo = db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(req.repoId) as { path: string } | undefined;
    if (repo === undefined) {
      return err({ ...notFound, message: "repo not found" });
    }
    const worktrees = db
      .prepare("SELECT id, branch FROM worktrees WHERE repo_id = ?")
      .all(req.repoId) as { id: string; branch: string }[];
    const checkedOut = new Map<string, string[]>();
    for (const worktree of worktrees) {
      const ids = checkedOut.get(worktree.branch) ?? [];
      ids.push(worktree.id);
      checkedOut.set(worktree.branch, ids);
    }
    return listRepoRefs(execGit, repo.path, checkedOut);
  });

  bus.register("repo:remoteBranches", async (req) => {
    const repo = db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(req.repoId) as { path: string } | undefined;
    if (repo === undefined) {
      return err({ ...notFound, message: "repo not found" });
    }
    return listRemoteBranchPage(execGit, repo.path, {
      ...(req.remote === undefined ? {} : { remote: req.remote }),
      ...(req.query === undefined ? {} : { query: req.query }),
      ...(req.offset === undefined ? {} : { offset: req.offset }),
      ...(req.limit === undefined ? {} : { limit: req.limit })
    });
  });

  bus.register("branch:create", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return err(notFound);

    if (req.checkout === "here") {
      // The renderer disables this choice for a dirty worktree, but its view of
      // dirtiness is a cached snapshot — re-check against the working copy so a
      // checkout can never carry (or clobber) work the user forgot about. The
      // check shares the queued slot with the checkout it guards: read it
      // outside and a pull holding the queue could reapply its auto-stash in
      // between, leaving the checkout to run on the tree we just cleared.
      const created = await operations.run(
        req.worktreeId,
        async (): Promise<Result<void>> => {
          const changes = await readChanges(execGit, row.path);
          if (!changes.ok) return err(changes.error);
          if (changes.value.staged.length + changes.value.unstaged.length > 0) {
            return err({
              kind: "repo",
              code: "dirty",
              message:
                "This worktree has uncommitted changes. Commit or stash them, or create the branch without checking it out."
            });
          }
          return checkoutNewBranchAt(
            execGit,
            row.path,
            req.branch,
            req.startPoint
          );
        }
      );
      if (!created.ok) return created;
      logMain(
        "info",
        "branch",
        `created ${req.branch} at ${req.startPoint} and checked it out in ${row.path}`
      );
      await indexer.refreshRepoWorktrees(row.repo_id);
      refresher.refreshWorktree(req.worktreeId);
      emitEvent("repo:changed", { profileId: row.profile_id });
      return ok({
        checkedOutWorktreeId: req.worktreeId,
        worktreePath: null
      });
    }

    let worktreePath: string | null = null;
    if (req.checkout === "new-worktree") {
      worktreePath = worktreePathFor(settings, row.repo_name, req.branch);
      const added = await worktreeAdd(
        execGit,
        row.repo_path,
        worktreePath,
        req.branch,
        { newBranch: true, startPoint: req.startPoint }
      );
      if (!added.ok) return added;
    } else {
      const created = await createBranchAt(
        execGit,
        row.path,
        req.branch,
        req.startPoint
      );
      if (!created.ok) return created;
    }
    logMain(
      "info",
      "branch",
      `created ${req.branch} at ${req.startPoint}${
        worktreePath === null ? "" : ` with a worktree at ${worktreePath}`
      }`
    );

    await indexer.refreshRepoWorktrees(row.repo_id);
    // The branch set this worktree can see changed even though its own checkout
    // did not, so the lineage graph needs a forced reload to draw the new tip —
    // refreshWorktree alone stays silent when the worktree state is unmoved.
    emitEvent("worktree:changed", { worktreeId: req.worktreeId });
    emitEvent("repo:changed", { profileId: row.profile_id });

    // A branch is checked out in at most one worktree, so the branch name
    // identifies the row the refresh just indexed. Reading it back beats
    // rebuilding the id from a path git may have normalised.
    const added =
      worktreePath === null
        ? undefined
        : (db
            .prepare("SELECT id FROM worktrees WHERE repo_id = ? AND branch = ?")
            .get(row.repo_id, req.branch) as { id: string } | undefined);

    return ok({
      checkedOutWorktreeId: added?.id ?? null,
      worktreePath
    });
  });

  bus.register("branch:switch", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      switchBranch(execGit, row.path, req.branch)
    );
    if (!result.ok) return result;
    logMain("info", "branch", `switched ${row.path} to ${req.branch}`);
    // The worktree's branch column is now stale — re-list (branch is keyed by
    // path, so the id is stable) and recompute state so the header, graph, and
    // sidebar all reflect the new checkout.
    await indexer.refreshRepoWorktrees(row.repo_id);
    refresher.refreshWorktree(req.worktreeId);
    emitEvent("repo:changed", { profileId: row.profile_id });
    return ok(null);
  });

  bus.register("branch:rename", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) {
      return err({ ...notFound, message: "repo not found" });
    }
    const result = await operations.runRepository(req.repoId, () =>
      renameLocalBranch(
        execGit,
        repo.path,
        { branch: req.branch, expectedHead: req.expectedHead },
        req.newBranch
      )
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "branch",
      `renamed local branch ${req.branch} to ${req.newBranch} in ${repo.path}`
    );
    await publishBranchMutation(req.repoId, repo.profile_id);
    return ok(null);
  });

  bus.register("branch:delete", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === undefined) {
      return err({ ...notFound, message: "repo not found" });
    }
    const result = await operations.runRepository(req.repoId, () =>
      deleteLocalBranch(
        execGit,
        repo.path,
        { branch: req.branch, expectedHead: req.expectedHead },
        req.force === true
      )
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "branch",
      `${req.force === true ? "force-deleted" : "deleted"} local branch ${req.branch} in ${repo.path}`
    );
    await publishBranchMutation(req.repoId, repo.profile_id);
    return ok(null);
  });
}
