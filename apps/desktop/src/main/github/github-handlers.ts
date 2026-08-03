import { ok, type GitHubCommitAuthorIdentityLookup } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { GitHubCommitAuthorIdentityService } from "./commit-author-identity";
import { getGhStatus } from "./pr-client";
import type { PrService } from "./pr-service";

export function registerGitHubHandlers(
  bus: CommandBus,
  prs: PrService,
  commitAuthorIdentities: GitHubCommitAuthorIdentityService
): void {
  bus.register("pr:refresh", async (req) => {
    const changed = await prs.refreshRepo(req.repoId, {
      ...(req.branches !== undefined ? { branches: req.branches } : {}),
      ...(req.trigger !== undefined ? { trigger: req.trigger } : {}),
      force: req.force ?? false
    });
    if (changed.size > 0) {
      // Targeted delta — the renderer patches these branches' PRs onto the tree
      // in place, no full repo:list reload.
      emitEvent("pr:changed", {
        repoId: req.repoId,
        prs: Object.fromEntries(changed)
      });
    }
    return ok(null);
  });

  bus.register("github:status", async () => ok(await getGhStatus()));

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
}
