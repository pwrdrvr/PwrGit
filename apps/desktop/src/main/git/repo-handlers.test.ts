import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type Repo, type RepoSearchHit } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { RepoIndexer } from "./repo-indexer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { createSystemGit } from "./test-support/system-git";
import { registerRepoHandlers } from "./repo-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";

vi.mock("../ipc", () => ({
  registerIpc: vi.fn(),
  emitEvent: vi.fn()
}));

const fossilRepo: Repo = {
  id: "fossil-repo",
  name: "linked-worktree",
  path: "/repos/linked-worktree",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};

const canonicalRepo: Repo = {
  id: "canonical-repo",
  name: "canonical",
  path: "/repos/canonical",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};

describe("repo handlers", () => {
  const refresher = {
    refreshWorktree: vi.fn(async () => undefined),
    refreshRepoWorktrees: vi.fn(async () => undefined)
  } satisfies WorktreeRefresher;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["new worktree", "existing worktree switches"])(
    "search discovers an externally assigned branch: %s",
    async (scenario) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-search-live-")));
      const db = openDatabase(":memory:");
      const git = (args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
      try {
        git(["init", "-b", "main"]);
        git([
          "-c", "user.name=Tester",
          "-c", "user.email=test@example.com",
          "-c", "commit.gpgsign=false",
          "commit", "--allow-empty", "-m", "init"
        ]);
        git(["branch", "fix/search-target"]);
        git(["branch", "fix/still-free"]);
        const checkout = join(root, "linked");
        if (scenario === "existing worktree switches") {
          git(["worktree", "add", "-b", "old-branch", checkout]);
        }
        const profiles = new ProfileService(db);
        const profile = profiles.create({
          name: "Test", email: "test@example.com", roots: []
        });
        const indexer = new RepoIndexer(db, createSystemGit());
        const indexed = await indexer.indexRepoAt(profile.id, root);
        if (!indexed.ok) throw new Error("index failed");
        expect(indexer.searchAll("fix/search-target")[0]?.kind).toBe("local_branch");
        if (scenario === "new worktree") {
          git(["worktree", "add", checkout, "fix/search-target"]);
        } else {
          git(["-C", checkout, "switch", "fix/search-target"]);
        }
        const bus = new CommandBus();
        registerRepoHandlers(bus, indexer, profiles, refresher);
        const result = await bus.dispatch("repo:search", {
          query: "fix/search-target"
        });
        expect(result).toEqual(ok([
          expect.objectContaining({
            kind: "worktree",
            name: "fix/search-target",
            path: checkout,
            worktreeId: expect.any(String),
            repoId: indexed.value.id
          })
        ]));
        expect(emitEvent).toHaveBeenCalledWith("repo:changed", {
          profileId: profile.id
        });
        expect(indexer.getRepo(indexed.value.id)?.worktrees).toContainEqual(
          expect.objectContaining({ branch: "fix/search-target", path: checkout })
        );
        expect(
          await bus.dispatch("repo:search", { query: "fix/still-free" })
        ).toEqual(ok([
          expect.objectContaining({
            kind: "local_branch", name: "fix/still-free"
          })
        ]));
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("checks each candidate repo once and does not probe ordinary worktree hits", async () => {
    const hit = (name: string, kind: RepoSearchHit["kind"]): RepoSearchHit => ({
      kind,
      name,
      repoId: canonicalRepo.id,
      path: canonicalRepo.path,
      profileId: canonicalRepo.profileId,
      profileName: "Test",
      pinned: false,
      worktreeCount: 0
    });
    const hits = [hit("fix/one", "local_branch"), hit("fix/two", "local_branch")];
    const searchAll = vi.fn(() => hits);
    const refreshRepoWorktrees = vi.fn(async () => ok({
      outcome: "reconciled" as const,
      repo: canonicalRepo,
      added: 0,
      removed: 0,
      updated: 0
    }));
    const indexer = { searchAll, refreshRepoWorktrees } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService, refresher);
    expect(await bus.dispatch("repo:search", { query: "fix" })).toEqual(ok(hits));
    expect(refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith(canonicalRepo.id);
    expect(refresher.refreshRepoWorktrees).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
    refreshRepoWorktrees.mockClear();
    searchAll.mockReturnValue([hit("fix/one", "worktree")]);
    await bus.dispatch("repo:search", { query: "fix/one" });
    expect(refreshRepoWorktrees).not.toHaveBeenCalled();
  });

  it("returns a reconciliation error instead of an unverified no-worktree claim", async () => {
    const failure = err({
      kind: "repo" as const,
      code: "not_found",
      message: "repo unavailable"
    });
    const indexer = {
      searchAll: vi.fn(() => [{ kind: "local_branch", repoId: canonicalRepo.id }]),
      refreshRepoWorktrees: vi.fn(async () => failure)
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService, refresher);
    expect(await bus.dispatch("repo:search", { query: "fix" })).toEqual(failure);
  });

  it("passes a deindexed fossil repo back as a success and refreshes the tree", async () => {
    const getRepo = vi.fn(() => fossilRepo);
    const indexer = {
      getRepo,
      refreshRepoWorktrees: vi.fn(async () =>
        ok({
          outcome: "deindexed" as const,
          profileId: fossilRepo.profileId,
          ownerPath: canonicalRepo.path
        })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService, refresher);

    const result = await bus.dispatch("repo:refreshWorktrees", {
      repoId: fossilRepo.id
    });

    // The row is gone and that is the correct outcome — the renderer must not
    // be handed an error it would render as "Couldn't refresh …".
    expect(result).toEqual(
      ok({
        outcome: "deindexed",
        profileId: fossilRepo.profileId,
        ownerPath: canonicalRepo.path
      })
    );
    expect(emitEvent).toHaveBeenCalledExactlyOnceWith("repo:changed", {
      profileId: fossilRepo.profileId
    });
    // profileId rides on the outcome, so the handler no longer has to read the
    // repo before deleting it just to learn where to send the event.
    expect(getRepo).not.toHaveBeenCalled();
    expect(refresher.refreshRepoWorktrees).not.toHaveBeenCalled();
  });

  it("refreshes reconciled worktree state before completing", async () => {
    const indexer = {
      getRepo: vi.fn(() => canonicalRepo),
      refreshRepoWorktrees: vi.fn(async () =>
        ok({
          outcome: "reconciled" as const,
          repo: canonicalRepo,
          added: 1,
          removed: 0,
          updated: 0
        })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService, refresher);

    const result = await bus.dispatch("repo:refreshWorktrees", {
      repoId: canonicalRepo.id
    });

    expect(result.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith(
      canonicalRepo.id
    );
    // The real refresher emits only after its state probes finish; the handler
    // must not also publish the stale pre-probe tree.
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
