import { err, ok, type Repo } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { IdentityService } from "../forge/identity-service";
import type { RepoIndexer } from "./repo-indexer";
import type { ForkService } from "./fork-service";
import type { WorktreeRefresher } from "./worktree-handlers";

export function registerForkHandlers(
  bus: CommandBus,
  forks: ForkService,
  identities: IdentityService,
  indexer: RepoIndexer,
  /** Re-reads one repository's worktree rows. Only the checkout-rewiring path
   *  needs it: that one changes a repository that is already on screen, where
   *  `repo:fork` produces a new row the tree reload picks up. */
  refresher?: Pick<WorktreeRefresher, "refreshRepoWorktrees">
): void {
  const active = new Map<string, AbortController>();

  /** Re-read the forge identity of a repository that just changed, and tell
   *  the renderer if it moved. Both fork paths want it for the same reason:
   *  the repository the user is looking at is the one repository in the list
   *  whose identity is worth a round trip right now. */
  const refreshIdentity = (profileId: string, repo: Repo): void => {
    void identities
      .refresh([repo], { force: true })
      .then((changed) => {
        if (changed.length > 0) {
          emitEvent("repo:identityChanged", { profileId, identities: changed });
        }
      })
      .catch((cause: unknown) => {
        logMain(
          "warn",
          "repo",
          `identity refresh after fork failed for ${repo.id}: ${String(cause)}`
        );
      });
  };
  bus.register("repo:forkTargets", (req) =>
    forks.targets(req.host, req.hostname)
  );
  bus.register("repo:forkPreflight", (req) => forks.preflight(req));
  bus.register("repo:forkCheckoutPreflight", (req) =>
    forks.checkoutPreflight(req)
  );
  bus.register("repo:fork", async (req) => {
    if (active.has(req.operationId)) {
      return err({
        kind: "validation",
        code: "duplicate_operation",
        message: "That fork operation is already running."
      });
    }
    const controller = new AbortController();
    active.set(req.operationId, controller);
    try {
      const result = await forks.fork(
        req,
        (progress) => {
          emitEvent("repo:forkProgress", {
            operationId: req.operationId,
            profileId: req.profileId,
            progress
          });
        },
        controller.signal
      );
      if (result.ok) {
        emitEvent("repo:changed", { profileId: req.profileId });
        refreshIdentity(req.profileId, result.value);
      }
      return result;
    } finally {
      active.delete(req.operationId);
    }
  });
  bus.register("repo:forkCheckout", async (req) => {
    if (active.has(req.operationId)) {
      return err({
        kind: "validation",
        code: "duplicate_operation",
        message: "That fork operation is already running."
      });
    }
    const controller = new AbortController();
    active.set(req.operationId, controller);
    try {
      const result = await forks.forkCheckout(
        req,
        (progress) => {
          emitEvent("repo:forkProgress", {
            operationId: req.operationId,
            profileId: req.profileId,
            progress
          });
        },
        controller.signal
      );
      if (result.ok) {
        // Three things changed about a repository that is already on screen,
        // and each has its own reader: the remote set (identity), the
        // remote-tracking branches (the branch index), and the rows the
        // sidebar draws. `repo:fork` needs none of this — its repository did
        // not exist a moment ago.
        const refreshed = await indexer.refreshRepoRemoteBranches(req.repoId);
        if (!refreshed.ok) {
          logMain(
            "warn",
            "repo",
            `fork rewire branch-index refresh failed for ${req.repoId}: ${refreshed.error.message}`
          );
        }
        // Both, and not redundantly: this repaints the tree now, while the
        // refresher re-computes per-worktree state and emits its own
        // `repo:changed` whenever that lands — which is a git call per
        // worktree later, and is also skipped entirely for a repo with no
        // worktree rows.
        emitEvent("repo:changed", { profileId: req.profileId });
        refresher?.refreshRepoWorktrees(req.repoId);
        refreshIdentity(req.profileId, result.value);
      }
      return result;
    } finally {
      active.delete(req.operationId);
    }
  });
  bus.register("repo:cancelFork", (req) => {
    active.get(req.operationId)?.abort({
      kind: "git",
      code: "aborted",
      message: "Fork canceled."
    });
    return ok(null);
  });
  bus.register("repo:refreshIdentities", async (req) => {
    const only = new Set(req.repoIds ?? []);
    const repos = indexer.listRepos(req.profileId).filter(
      (repo) =>
        (req.repoId === undefined || repo.id === req.repoId) &&
        (req.repoIds === undefined || only.has(repo.id))
    );
    const { changes: changed, outcomes } = await identities.refreshWithOutcomes(repos, {
      ...(req.force === undefined ? {} : { force: req.force })
    });
    if (changed.length > 0) {
      emitEvent("repo:identityChanged", {
        profileId: req.profileId,
        identities: changed
      });
    }
    return { ok: true as const, value: { changed: changed.length, outcomes } };
  });
}
