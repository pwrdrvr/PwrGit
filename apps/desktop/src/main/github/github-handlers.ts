import {
  ok,
  type GitHubCommitAuthorIdentityLookup,
  type PrSummary
} from "@pwrgit/shared";
import type { CommandBus, CommandContext } from "../command-bus";
import { emitEvent } from "../ipc";
import type { GitHubCommitAuthorIdentityService } from "./commit-author-identity";
import { CommitAssociationMonitor } from "./commit-association-monitor";
import { ForgeStatusService } from "../forge/status";
import { PrStatusMonitor, type PrMonitorTarget } from "./pr-status-monitor";
import type { PrService, PrStatusDeltas } from "./pr-service";

const MAX_VISIBLE_COMMIT_MONITORS = 200;

function boundedCommitHashes(hashes: string[]): string[] {
  return [...new Set(hashes.map((hash) => hash.trim().toLowerCase()))]
    .filter((hash) => /^[0-9a-f]{40}$/.test(hash))
    .slice(0, MAX_VISIBLE_COMMIT_MONITORS);
}

export function registerGitHubHandlers(
  bus: CommandBus,
  prs: PrService,
  commitAuthorIdentities: GitHubCommitAuthorIdentityService,
  forgeStatus: ForgeStatusService = new ForgeStatusService()
): {
  stop: () => void;
  releaseWebContents: (webContentsId: number) => void;
} {
  const publishBranchPrs = (
    repoId: string,
    changed: Map<string, PrSummary | null>
  ): void => {
    if (changed.size === 0) return;
    emitEvent("pr:changed", { repoId, prs: Object.fromEntries(changed) });
  };
  const publishCommitPrs = (
    repoId: string,
    changed: Map<string, PrSummary | null>
  ): void => {
    if (changed.size === 0) return;
    emitEvent("pr:commitChanged", {
      repoId,
      prs: Object.fromEntries(changed)
    });
  };
  const publishStatusDeltas = (repoId: string, deltas: PrStatusDeltas): void => {
    publishBranchPrs(repoId, deltas.branches);
    publishCommitPrs(repoId, deltas.commits);
  };
  const prStatusMonitor = new PrStatusMonitor({
    refresh: async (repoId, numbers) => {
      publishStatusDeltas(repoId, await prs.refreshPrNumbers(repoId, numbers));
    }
  });
  const reasonGenerations = new Map<string, number>();
  const reasonsByWebContents = new Map<number, Set<string>>();
  const ownedReason = (
    kind: "commit-list" | "worktree",
    monitorId: string,
    ctx: CommandContext
  ): string | null => {
    const webContentsId = ctx.webContentsId;
    if (webContentsId === undefined) return null;
    const reasonId = `${kind}:webContents:${webContentsId}:${monitorId}`;
    const reasons = reasonsByWebContents.get(webContentsId) ?? new Set<string>();
    reasons.add(reasonId);
    reasonsByWebContents.set(webContentsId, reasons);
    return reasonId;
  };
  const replaceReason = (
    reasonId: string,
    targets: PrMonitorTarget[]
  ): number => {
    const generation = (reasonGenerations.get(reasonId) ?? 0) + 1;
    reasonGenerations.set(reasonId, generation);
    prStatusMonitor.replace(reasonId, targets);
    return generation;
  };
  const replaceReasonIfCurrent = (
    reasonId: string,
    generation: number,
    targets: PrMonitorTarget[]
  ): void => {
    if (reasonGenerations.get(reasonId) === generation) {
      prStatusMonitor.replace(reasonId, targets);
    }
  };
  const targetsForCommitCache = (
    repoId: string,
    cached: Map<string, PrSummary | null>
  ): PrMonitorTarget[] => {
    const targets = new Map<number, PrMonitorTarget>();
    for (const pr of cached.values()) {
      if (pr !== null) targets.set(pr.number, { repoId, number: pr.number });
    }
    return [...targets.values()];
  };
  const visibleCommitReasons = new Map<
    string,
    { repoId: string; hashes: string[]; generation: number }
  >();
  let commitAssociationMonitor: CommitAssociationMonitor;
  const syncVisibleReason = (reasonId: string): void => {
    const reason = visibleCommitReasons.get(reasonId);
    if (
      reason === undefined ||
      reasonGenerations.get(reasonId) !== reason.generation
    ) {
      return;
    }
    const cached = prs.cachedCommitPrs(reason.repoId, reason.hashes);
    prStatusMonitor.replace(
      reasonId,
      targetsForCommitCache(reason.repoId, cached)
    );
    commitAssociationMonitor.replace(
      reasonId,
      reason.repoId,
      reason.hashes.filter((hash) => cached.get(hash) == null)
    );
  };
  const syncVisibleReasonsForRepo = (repoId: string): void => {
    for (const [reasonId, reason] of visibleCommitReasons) {
      if (reason.repoId === repoId) syncVisibleReason(reasonId);
    }
  };
  const clearVisibleReason = (reasonId: string, repoId: string): void => {
    visibleCommitReasons.delete(reasonId);
    replaceReason(reasonId, []);
    commitAssociationMonitor.replace(reasonId, repoId, []);
  };
  commitAssociationMonitor = new CommitAssociationMonitor({
    refresh: async (repoId, hashes) => {
      publishCommitPrs(
        repoId,
        await prs.refreshCommits(repoId, hashes, { trigger: "scheduled" })
      );
      syncVisibleReasonsForRepo(repoId);
    }
  });

  bus.register("pr:refresh", async (req) => {
    const changed = await prs.refreshRepo(req.repoId, {
      ...(req.branches !== undefined ? { branches: req.branches } : {}),
      ...(req.trigger !== undefined ? { trigger: req.trigger } : {}),
      force: req.force ?? false
    });
    // Targeted delta — the renderer patches these branches' PRs onto the tree
    // in place, no full repo:list reload.
    publishBranchPrs(req.repoId, changed);
    return ok(null);
  });

  // Answered from main's cache, so a StrictMode double-mount costs one read
  // rather than two subprocess probes. Changes are pushed, never polled.
  const stopForgeStatus = forgeStatus.onChange((forges) => {
    emitEvent("forge:statusChanged", { forges });
  });
  bus.register("forge:status", async () =>
    ok({ forges: await forgeStatus.list() })
  );

  bus.register("pr:replaceVisibleCommits", async (req, ctx) => {
    const hashes = boundedCommitHashes(req.commitHashes);
    const monitorId = req.monitorId.trim().slice(0, 128);
    if (monitorId === "") return ok({});
    const reasonId = ownedReason("commit-list", monitorId, ctx);
    if (reasonId === null) return ok({});
    if (hashes.length === 0) {
      clearVisibleReason(reasonId, req.repoId);
      return ok({});
    }
    if (!prs.ownsWorktree(req.repoId, req.worktreeId)) {
      clearVisibleReason(reasonId, req.repoId);
      return ok({});
    }

    // Install the replacement synchronously from cache before any network
    // work. Unknown associations remain in a visible-only discovery monitor;
    // known associations move into the PR-number status monitor.
    const generation = (reasonGenerations.get(reasonId) ?? 0) + 1;
    reasonGenerations.set(reasonId, generation);
    visibleCommitReasons.set(reasonId, {
      repoId: req.repoId,
      hashes,
      generation
    });
    syncVisibleReason(reasonId);
    const cached = prs.cachedCommitPrs(req.repoId, hashes);
    // Return the cache without waiting for GitHub. Fresh discoveries arrive on
    // the existing event channel, so a scope switch can paint known PRs in the
    // same frame while uncached rows continue resolving in the background.
    void prs
      .refreshCommits(req.repoId, hashes, { trigger: "scheduled" })
      .then((changed) => {
        publishCommitPrs(req.repoId, changed);
        syncVisibleReason(reasonId);
      })
      .catch(() => undefined);
    return ok(Object.fromEntries(cached));
  });

  bus.register("pr:refreshCommits", async (req) => {
    const hashes = boundedCommitHashes(req.commitHashes);
    const changed = await prs.refreshCommits(req.repoId, hashes, {
      trigger: req.trigger ?? "user"
    });
    publishCommitPrs(req.repoId, changed);
    syncVisibleReasonsForRepo(req.repoId);
    return ok(Object.fromEntries(prs.cachedCommitPrs(req.repoId, hashes)));
  });

  bus.register("pr:replaceWorktreeMonitor", async (req, ctx) => {
    const monitorId = req.monitorId.trim().slice(0, 128);
    if (monitorId === "") return ok(null);
    const reasonId = ownedReason("worktree", monitorId, ctx);
    if (reasonId === null) return ok(null);
    const target = req.target;
    if (target === undefined) {
      replaceReason(reasonId, []);
      return ok(null);
    }
    if (!prs.ownsWorktreeBranch(target.repoId, target.worktreeId, target.branch)) {
      replaceReason(reasonId, []);
      return ok(null);
    }
    let pr = prs.cachedBranchPr(target.repoId, target.branch);
    const generation = replaceReason(
      reasonId,
      pr == null ? [] : [{ repoId: target.repoId, number: pr.number }]
    );
    publishBranchPrs(
      target.repoId,
      await prs.refreshRepo(target.repoId, {
        branches: [target.branch],
        trigger: "scheduled"
      })
    );
    pr = prs.cachedBranchPr(target.repoId, target.branch);
    replaceReasonIfCurrent(
      reasonId,
      generation,
      pr == null ? [] : [{ repoId: target.repoId, number: pr.number }]
    );
    return ok(null);
  });

  bus.register("github:hydrateCommitAuthorIdentities", async (req) => {
    // Start the whole batch before awaiting any one commit. The identity
    // service then coalesces the worktree's `git remote get-url origin` proof,
    // so a large graph performs one origin validation instead of serially
    // spawning Git once per row. A miss remains strictly local-cache-only.
    const hydrate = async (
      commits: typeof req.commits
    ): Promise<Record<string, GitHubCommitAuthorIdentityLookup>> =>
      Object.fromEntries(await Promise.all(commits.map((commit) => {
        const emitBackgroundUpdate = (
          lookup: GitHubCommitAuthorIdentityLookup
        ): void => {
          emitEvent("github:commitAuthorIdentityChanged", {
            worktreeId: req.worktreeId,
            commitHash: commit.commitHash,
            lookup
          });
        };
        const request = commitAuthorIdentities.request(
          {
            worktreeId: req.worktreeId,
            commitHash: commit.commitHash,
            authorName: commit.authorName,
            authorEmail: commit.authorEmail,
            cacheOnly: true
          },
          emitBackgroundUpdate
        );
        return (
          request.completion?.then(
            (lookup) => [commit.commitHash, lookup] as const
          ) ?? Promise.resolve([commit.commitHash, request.lookup] as const)
        );
      })));

    const lookups = await hydrate(req.commits);
    // Exact rows encountered anywhere in the first pass backfill reusable
    // author accounts. Retry local misses once so a newly landed SHA by that
    // author is complete before graph rows become interactive.
    const unresolved = req.commits.filter((commit) => {
      const lookup = lookups[commit.commitHash];
      return lookup?.identity === undefined &&
        lookup?.cacheState === "miss" &&
        lookup.refreshState === "idle";
    });
    if (unresolved.length > 0) Object.assign(lookups, await hydrate(unresolved));
    return ok(lookups);
  });

  bus.register("github:commitAuthorIdentity", (req) => {
    const emitLookup = (lookup: GitHubCommitAuthorIdentityLookup): void => {
      emitEvent("github:commitAuthorIdentityChanged", {
        worktreeId: req.worktreeId,
        commitHash: req.commitHash,
        lookup
      });
    };
    // A very fast stale revalidation must not overtake the first cache event:
    // renderers need to see the current local thumbnail before any refreshed
    // replacement. Queue background deltas until that initial event emits.
    let initialEmitted = false;
    const queuedUpdates: GitHubCommitAuthorIdentityLookup[] = [];
    const emitBackgroundUpdate = (lookup: GitHubCommitAuthorIdentityLookup): void => {
      if (!initialEmitted) {
        queuedUpdates.push(lookup);
        return;
      }
      emitLookup(lookup);
    };
    const request = commitAuthorIdentities.request(req, emitBackgroundUpdate);
    void request.completion?.then((lookup) => {
      emitLookup(lookup);
      initialEmitted = true;
      for (const update of queuedUpdates) emitLookup(update);
    });
    // A cache-only graph warm must wait for its local origin/proof/thumbnail
    // read so the renderer's small worker pool is a real concurrency bound.
    // Normal hover requests still return their optimistic placeholder without
    // waiting for local or network work.
    if (req.cacheOnly && request.completion !== undefined) {
      return request.completion.then((lookup) => ok(lookup));
    }
    return ok(request.lookup);
  });

  const releaseWebContents = (webContentsId: number): void => {
    const reasons = reasonsByWebContents.get(webContentsId);
    if (reasons === undefined) return;
    for (const reasonId of reasons) {
      const visible = visibleCommitReasons.get(reasonId);
      if (visible !== undefined) {
        commitAssociationMonitor.replace(reasonId, visible.repoId, []);
        visibleCommitReasons.delete(reasonId);
      }
      prStatusMonitor.replace(reasonId, []);
      reasonGenerations.delete(reasonId);
    }
    reasonsByWebContents.delete(webContentsId);
  };

  const stop = (): void => {
    stopForgeStatus();
    visibleCommitReasons.clear();
    reasonGenerations.clear();
    reasonsByWebContents.clear();
    commitAssociationMonitor.stop();
    prStatusMonitor.stop();
  };

  return { stop, releaseWebContents };
}
