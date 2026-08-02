import { ok } from "@pwrgit/shared";
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
    const request = commitAuthorIdentities.request(req);
    void request.completion?.then((lookup) => {
      emitEvent("github:commitAuthorIdentityChanged", {
        worktreeId: req.worktreeId,
        commitHash: req.commitHash,
        lookup
      });
    });
    return ok(request.lookup);
  });
}
