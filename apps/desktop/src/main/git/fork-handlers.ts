import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { IdentityService } from "../forge/identity-service";
import type { RepoIndexer } from "./repo-indexer";
import type { ForkService } from "./fork-service";

export function registerForkHandlers(
  bus: CommandBus,
  forks: ForkService,
  identities: IdentityService,
  indexer: RepoIndexer
): void {
  bus.register("repo:forkTargets", (req) => forks.targets(req.host));
  bus.register("repo:forkPreflight", (req) => forks.preflight(req));
  bus.register("repo:fork", async (req) => {
    const result = await forks.fork(req, (progress) => {
      emitEvent("repo:forkProgress", {
        operationId: req.operationId,
        profileId: req.profileId,
        progress
      });
    });
    if (result.ok) {
      emitEvent("repo:changed", { profileId: req.profileId });
      // A repo that was just forked has an identity worth knowing immediately
      // — it is the one repo in the list the user is definitely looking at.
      void identities
        .refresh([result.value], { force: true })
        .then((changed) => {
          if (changed.length > 0) {
            emitEvent("repo:identityChanged", {
              profileId: req.profileId,
              identities: changed
            });
          }
        });
    }
    return result;
  });
  bus.register("repo:refreshIdentities", async (req) => {
    const changed = await identities.refresh(indexer.listRepos(req.profileId), {
      ...(req.force === undefined ? {} : { force: req.force })
    });
    if (changed.length > 0) {
      emitEvent("repo:identityChanged", {
        profileId: req.profileId,
        identities: changed
      });
    }
    return { ok: true as const, value: { changed: changed.length } };
  });
}
