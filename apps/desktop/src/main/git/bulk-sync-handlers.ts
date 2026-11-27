import {
  err,
  ok,
  resolveSourceForgeRepo,
  siblingForkCandidates,
  type BulkSyncForkMode,
  type ForgeHostMap,
  type RepoIdentity,
  type SiblingForkCandidate
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import { withResourceSource } from "../diagnostics/resource-usage";
import type { DB } from "../persistence/db";
import { bulkSyncRepositories, type BulkSyncRepoInput } from "./bulk-sync";
import { execGit, sanitizeGitLogDetail } from "./dugite";
import { readForkSyncPrefs, readRemoteIdentities } from "./fork-sync-remotes";
import { listRemoteEndpoints } from "./git-service";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { visibleRepoSql } from "./hidden-repos";
import { tagAutoChecksFor } from "./tag-auto-check";

export type BulkSyncHandlers = {
  /** Cancel work owned by a renderer window that has gone away. */
  releaseWebContents: (webContentsId: number) => void;
};

export type BulkSyncForkSupport = {
  /** Whether bulk soft-pull should sync clean fork branches with upstream. */
  enabled: () => boolean;
  readIdentity?: (repoId: string) => RepoIdentity | undefined;
  hostsForRemotes?: () => ForgeHostMap;
  ensureRemoteIdentities?: (
    repoId: string,
    candidates: readonly SiblingForkCandidate[]
  ) => Promise<boolean>;
};

type RepoRow = {
  id: string;
  name: string;
  path: string;
  /** 1 when a present checkout's stored state, still for the branch it has
   * checked out, is clean and behind its upstream without being ahead: a
   * fast-forward Try pull can very likely make. */
  pullPending: number;
};
type WorktreeRow = {
  id: string;
  repoId: string;
  branch: string;
  path: string;
};

export function profileRepos(
  db: DB,
  profileId: string,
  repoIds?: readonly string[],
  options?: { syncForks?: boolean }
): BulkSyncRepoInput[] | null {
  const profile = db
    .prepare("SELECT id FROM profiles WHERE id = ?")
    .get(profileId) as { id: string } | undefined;
  if (profile === undefined) return null;
  const syncForks = options?.syncForks === true ? 1 : 0;
  const repos = db
    .prepare(
      // A hidden repository sits out Fetch all and Try pull all.
      `SELECT id, name, path,
         EXISTS (
           -- Stored state only orders the run's starts; Try pull re-inspects
           -- every checkout itself.
           SELECT 1 FROM worktrees w
           JOIN worktree_state s ON s.worktree_id = w.id
           WHERE w.repo_id = r.id AND w.missing = 0 AND s.branch = w.branch
             AND s.dirty = 0 AND s.has_upstream = 1
             AND (
               (s.behind > 0 AND s.ahead = 0)
               OR (? = 1 AND s.source_behind > 0 AND s.source_ahead = 0)
             )
         ) AS pullPending
       FROM repos r
       WHERE profile_id = ? AND ${visibleRepoSql("r")}
       ORDER BY name COLLATE NOCASE, name, id`
    )
    .all(syncForks, profileId) as RepoRow[];
  const worktrees = db
    .prepare(
      `SELECT w.id, w.repo_id AS repoId, w.branch, w.path
       FROM worktrees w
       JOIN repos r ON r.id = w.repo_id
       -- A checkout that is gone has nothing to pull; the repo-level fetch
       -- still runs from the primary.
       WHERE r.profile_id = ? AND w.missing = 0 AND ${visibleRepoSql("r")}
       ORDER BY w.repo_id, w.is_primary DESC, w.branch COLLATE NOCASE, w.id`
    )
    .all(profileId) as WorktreeRow[];
  const byRepo = new Map<string, WorktreeRow[]>();
  for (const worktree of worktrees) {
    const rows = byRepo.get(worktree.repoId) ?? [];
    rows.push(worktree);
    byRepo.set(worktree.repoId, rows);
  }
  const wanted = repoIds === undefined ? null : new Set(repoIds);
  return repos
    .filter((repo) => wanted === null || wanted.has(repo.id))
    .map(({ pullPending, ...repo }) => ({
      ...repo,
      ...(pullPending === 1 ? { pullPending: true } : {}),
      worktrees: (byRepo.get(repo.id) ?? []).map(
        ({ repoId: _repoId, ...row }) => row
      )
    }));
}

/** Profile-wide fetch and conservative pull handlers with cooperative cancel. */
export function registerBulkSyncHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue,
  indexer?: Pick<RepoIndexer, "refreshRepoRemoteBranches">,
  refreshIdentity?: (repoId: string) => void,
  /** A run is starting: look at the roots for new repositories too. */
  onRunStart?: (profileId: string) => void,
  forkSync?: BulkSyncForkSupport
): BulkSyncHandlers {
  const active = new Map<
    string,
    { controller: AbortController; webContentsId?: number }
  >();

  const discoverSiblings = (
    profileId: string,
    repoId: string,
    cwd: string,
    trackedRemote: string | null,
    sourceRemote: string
  ): void => {
    const ensure = forkSync?.ensureRemoteIdentities;
    if (ensure === undefined) return;
    void listRemoteEndpoints(execGit, cwd).then((endpoints) => {
      if (!endpoints.ok) return;
      const identity = forkSync?.readIdentity?.(repoId);
      const hosts = forkSync?.hostsForRemotes?.() ?? {};
      const source = resolveSourceForgeRepo(
        endpoints.value,
        sourceRemote,
        identity,
        hosts
      );
      if (source === null) return;
      const candidates = siblingForkCandidates(endpoints.value, {
        sourceRemote,
        trackedRemote,
        source,
        hosts
      });
      if (candidates.length === 0) return;
      return ensure(repoId, candidates).then((changed) => {
        if (!changed) return;
        const latestIdentity = forkSync?.readIdentity?.(repoId);
        if (latestIdentity !== undefined) {
          emitEvent("repo:identityChanged", {
            profileId,
            identities: [{ repoId, identity: latestIdentity }]
          });
        }
        emitEvent("repo:changed", {
          profileId,
          repoIds: [repoId]
        });
        emitEvent("graph:changed", { repoId });
      });
    }).catch((cause: unknown) => {
      logMain(
        "debug",
        "forge",
        `bulk sync sibling fork discovery failed for ${cwd}: ${sanitizeGitLogDetail(cause)}`
      );
    });
  };

  bus.register("remote:cancelBulkSync", (req, ctx) => {
    const operation = active.get(req.operationId);
    if (operation === undefined) return ok({ cancelled: false });
    if (
      operation.webContentsId !== undefined &&
      ctx.webContentsId !== undefined &&
      operation.webContentsId !== ctx.webContentsId
    ) {
      return ok({ cancelled: false });
    }
    operation.controller.abort({
      kind: "remote",
      code: "aborted",
      message: "Repository synchronization was cancelled."
    });
    return ok({ cancelled: true });
  });

  bus.register("remote:bulkSync", async (req, ctx) => {
    if (req.operationId.trim() === "") {
      return err({
        kind: "validation",
        code: "invalid_operation_id",
        message: "Bulk synchronization needs an operation id."
      });
    }
    if (active.has(req.operationId)) {
      return err({
        kind: "remote",
        code: "operation_in_progress",
        message: "This bulk synchronization is already running."
      });
    }
    const syncForks = req.mode === "soft-pull" && forkSync?.enabled() === true;
    const repos = profileRepos(db, req.profileId, req.repoIds, { syncForks });
    if (repos === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    if (syncForks) {
      const hosts = forkSync?.hostsForRemotes?.() ?? {};
      for (const repo of repos) {
        const mode: BulkSyncForkMode = req.forkModes?.[repo.id] ?? "sync";
        if (mode === "tracked") continue;
        const identity = forkSync?.readIdentity?.(repo.id);
        const parent =
          identity?.parent === undefined
            ? null
            : {
                hostname: identity.hostname,
                nameWithOwner: identity.parent.nameWithOwner
              };
        repo.forkSync = {
          mode,
          parent,
          ...(identity === undefined ? {} : { identity }),
          remoteIdentities: readRemoteIdentities(db, repo.id),
          forkSyncPrefs: readForkSyncPrefs(db, repo.id),
          hosts,
          ...(forkSync?.ensureRemoteIdentities === undefined
            ? {}
            : {
                onDiscoverSiblings: (trackedRemote, sourceRemote) =>
                  discoverSiblings(
                    req.profileId,
                    repo.id,
                    repo.path,
                    trackedRemote,
                    sourceRemote
                  )
              })
        };
      }
    }

    onRunStart?.(req.profileId);

    const controller = new AbortController();
    const abortFromContext = (): void => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted === true) abortFromContext();
    else ctx.signal?.addEventListener("abort", abortFromContext, { once: true });
    active.set(req.operationId, {
      controller,
      ...(ctx.webContentsId === undefined
        ? {}
        : { webContentsId: ctx.webContentsId })
    });
    logMain(
      "info",
      "remote",
      `bulk ${req.mode} started for profile ${req.profileId}: ${repos.length} repositories`
    );
    try {
      const summary = await withResourceSource(req.mode === "fetch" ? "bulk-fetch" : "bulk-pull", () => bulkSyncRepositories(execGit, repos, {
        operationId: req.operationId,
        mode: req.mode,
        signal: controller.signal,
        runRepository: (repoId, operation) =>
          operations.runRepository(repoId, operation),
        runWorktree: (worktreeId, operation) =>
          operations.run(worktreeId, operation),
        onProgress: (progress) =>
          emitEvent("remote:bulkSyncProgress", progress),
        onRepoCompleted: async (repo, result) => {
          const fetched = result.remotes.some(
            (remote) => remote.outcome === "fetched"
          );
          const fetchedChanges = fetched && result.refsChanged !== false;
          const headMoved = result.worktrees.some(
            (worktree) =>
              worktree.outcome === "updated" ||
              (worktree.afterHead !== undefined &&
                worktree.afterHead !== worktree.beforeHead)
          );
          const pushedFork = result.worktrees.some(
            (worktree) =>
              worktree.forkPushes?.some((push) => push.outcome === "pushed") ===
              true
          );
          if (fetchedChanges) refreshIdentity?.(repo.id);
          if ((fetchedChanges || pushedFork) && indexer !== undefined) {
            try {
              const indexed = await operations.runRepository(repo.id, () =>
                indexer.refreshRepoRemoteBranches(repo.id)
              );
              if (!indexed.ok) {
                logMain(
                  "warn",
                  "remote",
                  `bulk ${req.mode} branch-index refresh failed for ${repo.path}: ${indexed.error.message}`
                );
              }
            } catch (cause) {
              logMain(
                "warn",
                "remote",
                `bulk ${req.mode} branch-index refresh failed for ${repo.path}: ${sanitizeGitLogDetail(cause)}`
              );
            }
          }
          if (fetchedChanges || headMoved || pushedFork) {
            try {
              await refresher.refreshRepoWorktrees(repo.id);
            } catch (cause) {
              logMain(
                "warn",
                "remote",
                `bulk ${req.mode} state refresh failed for ${repo.path}: ${sanitizeGitLogDetail(cause)}`
              );
            }
          }
          if (headMoved || pushedFork) {
            emitEvent("graph:changed", { repoId: repo.id });
          }
          // Timed and bulk syncs check tags as a toolbar Fetch does: behind
          // the sync menu's switch, hourly at most, a few at a time.
          if (fetched || result.remotes.some((remote) => remote.reason === "unchanged")) tagAutoChecksFor(db).afterSync(repo.id);
          logMain(
            result.outcome === "failed" ? "warn" : "info",
            "remote",
            `bulk ${req.mode} ${result.outcome} for ${repo.path}`
          );
        }
      }));
      logMain(
        summary.cancelled ? "warn" : "info",
        "remote",
        `bulk ${req.mode} finished for profile ${req.profileId}: ${summary.counts.repos.success} succeeded, ${summary.counts.repos.partial} partial, ${summary.counts.repos.skipped} skipped, ${summary.counts.repos.failed} failed, ${summary.counts.repos.cancelled} cancelled`
      );
      return ok(summary);
    } finally {
      active.delete(req.operationId);
      ctx.signal?.removeEventListener("abort", abortFromContext);
    }
  });

  return {
    releaseWebContents: (webContentsId) => {
      for (const operation of active.values()) {
        if (operation.webContentsId !== webContentsId) continue;
        operation.controller.abort({
          kind: "remote",
          code: "aborted",
          message: "The window that started synchronization was closed."
        });
      }
    }
  };
}
