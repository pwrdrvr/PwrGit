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
