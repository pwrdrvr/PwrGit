import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, type BulkSyncSummary, type RepoIdentity } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { BulkSyncOptions, BulkSyncRepoInput } from "./bulk-sync";
import { execGit } from "./dugite";
import { setForkSyncRemotePref, writeRemoteIdentity } from "./fork-sync-remotes";
import { profileRepos, registerBulkSyncHandlers } from "./bulk-sync-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

type BulkSyncOverride = (
  git: typeof execGit,
  repos: BulkSyncRepoInput[],
  options: BulkSyncOptions
) => Promise<BulkSyncSummary>;

let bulkSyncOverride: BulkSyncOverride | undefined;

vi.mock("./bulk-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bulk-sync")>();
  return {
    ...actual,
    bulkSyncRepositories: (
      git: typeof execGit,
      repos: BulkSyncRepoInput[],
      options: BulkSyncOptions
    ) =>
      bulkSyncOverride !== undefined
        ? bulkSyncOverride(git, repos, options)
        : actual.bulkSyncRepositories(git, repos, options)
  };
});

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./dugite", async (importOriginal) => ({
  ...await importOriginal<typeof import("./dugite")>(),
  execGit: vi.fn()
}));

afterEach(() => {
  bulkSyncOverride = undefined;
  vi.clearAllMocks();
});

describe("bulk sync identity refresh", () => {
  it.each(["fetch", "soft-pull"] as const)(
    "refreshes only repositories with a successful fetch during %s",
    async (mode) => {
      const db = {
        prepare: (sql: string) => ({
          get: () => ({ id: "profile-1" }),
          all: () => sql.includes("FROM repos")
            ? ["success", "failed", "skipped"].map((id) => ({ id, name: id, path: `/repos/${id}` }))
            : []
        })
      } as unknown as DB;
      vi.mocked(execGit).mockImplementation(async (args, cwd) => {
        if (args[0] === "remote") return ok({ exitCode: 0, stdout: "origin\n", stderr: "" });
        if (args[0] === "config") return ok({ exitCode: 0, stdout: cwd.endsWith("skipped") ? "true" : "false", stderr: "" });
        if (args[0] === "fetch") return ok({ exitCode: cwd.endsWith("failed") ? 1 : 0, stdout: "", stderr: "" });
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      });
      const refreshIdentity = vi.fn();
      const bus = new CommandBus();
      registerBulkSyncHandlers(bus, db, {
        refreshWorktree: vi.fn(),
        refreshRepoWorktrees: vi.fn()
      }, new WorktreeOperationQueue(), undefined, refreshIdentity);

      const result = await bus.dispatch("remote:bulkSync", {
        profileId: "profile-1", operationId: "bulk-1", mode
      });
      expect(result.ok).toBe(true);
      expect(refreshIdentity).toHaveBeenCalledExactlyOnceWith("success");
    }
  );
});

describe("bulk sync and the profile's folders", () => {
  it("looks for new repositories at the start of every run", async () => {
    // A Fetch/Pull run, yours or the timer's, is when new clones get looked
    // for (root-discovery.ts); an unknown profile starts nothing.
    const db = {
      prepare: (sql: string) => ({
        get: (id: string) => (id === "profile-1" ? { id } : undefined),
        all: () => (sql.includes("FROM repos") ? [] : [])
      })
    } as unknown as DB;
    const onRunStart = vi.fn();
    const bus = new CommandBus();
    registerBulkSyncHandlers(bus, db, {
      refreshWorktree: vi.fn(),
      refreshRepoWorktrees: vi.fn()
    }, new WorktreeOperationQueue(), undefined, undefined, onRunStart);

    await bus.dispatch("remote:bulkSync", {
      profileId: "profile-1", operationId: "bulk-1", mode: "fetch"
    });
    await bus.dispatch("remote:bulkSync", {
      profileId: "nobody", operationId: "bulk-2", mode: "fetch"
    });
    expect(onRunStart).toHaveBeenCalledExactlyOnceWith("profile-1");
  });
});

describe("profileRepos and pending pulls", () => {
  // Rule: a repository is marked as having a pending pull exactly when one of
  // its present checkouts has stored state, for the branch still checked out, that is behind its upstream, not
  // ahead and clean (what Try pull can fast-forward). Another profile's
  // identical rows never mark this profile's repositories.
  it("marks only this profile's repositories with a clean, behind checkout", () => {
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const mine = profiles.create({ name: "mine", email: "mine@example.com", roots: [] }).id;
    const theirs = profiles.create({ name: "theirs", email: "theirs@example.com", roots: [] }).id;
    type State = { upstream: number; ahead: number; behind: number; dirty: number; missing?: number } | null;
    const seed = (profileId: string, id: string, states: State[]): void => {
      db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
        .run(id, profileId, id, `/checkouts/${id}`);
      states.forEach((state, index) => {
        const wt = `${id}-wt${index}`;
        db.prepare(
          "INSERT INTO worktrees (id, repo_id, branch, path, is_primary, missing) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(wt, id, `b${index}`, `/checkouts/${id}/${index}`, index === 0 ? 1 : 0, state?.missing ?? 0);
        if (state === null) return;
        db.prepare(
          `INSERT INTO worktree_state (worktree_id, branch, has_upstream, ahead, behind, dirty)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(wt, `b${index}`, state.upstream, state.ahead, state.behind, state.dirty);
      });
    };
    const clean = { upstream: 1, ahead: 0, behind: 0, dirty: 0 };
    seed(mine, "a-current", [clean, null]);
    seed(mine, "b-behind", [clean, { ...clean, behind: 2 }]);
    seed(mine, "c-dirty", [{ ...clean, behind: 1, dirty: 3 }]);
    seed(mine, "d-diverged", [{ ...clean, behind: 1, ahead: 1 }]);
    seed(mine, "e-no-upstream", [{ ...clean, upstream: 0, behind: 1 }]);
    seed(mine, "f-gone", [clean, { ...clean, behind: 1, missing: 1 }]);
    seed(mine, "g-switched", [{ ...clean, behind: 1 }]);
    // The checkout moved to another branch since its state was stored.
    db.prepare("UPDATE worktrees SET branch = 'other' WHERE id = 'g-switched-wt0'").run();
    seed(theirs, "h-theirs", [{ ...clean, behind: 5 }]);

    const repos = profileRepos(db, mine);
    expect(repos?.map((repo) => [repo.id, repo.pullPending === true])).toEqual([
      ["a-current", false],
      ["b-behind", true],
      ["c-dirty", false],
      ["d-diverged", false],
      ["e-no-upstream", false],
      ["f-gone", false],
      ["g-switched", false]
    ]);
    // Worktree inputs carry no stored-state columns.
    expect(repos?.find((repo) => repo.id === "b-behind")?.worktrees).toEqual([
      { id: "b-behind-wt0", branch: "b0", path: "/checkouts/b-behind/0" },
      { id: "b-behind-wt1", branch: "b1", path: "/checkouts/b-behind/1" }
    ]);
    expect(profileRepos(db, theirs)?.map((repo) => repo.pullPending)).toEqual([true]);
  });

  it("prioritizes clean fork-behind repositories only when syncForks is enabled", () => {
    const db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const profileId = profiles.create({ name: "mine", email: "mine@example.com", roots: [] }).id;
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
      .run("fork-behind", profileId, "t3code", "/checkouts/t3code");
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary, missing) VALUES (?, ?, ?, ?, 1, 0)"
    ).run("wt-main", "fork-behind", "main", "/checkouts/t3code");
    db.prepare(
      `INSERT INTO worktree_state
         (worktree_id, branch, has_upstream, ahead, behind, dirty, source_ahead, source_behind)
       VALUES (?, ?, 1, 0, 0, 0, 0, 89)`
    ).run("wt-main", "main");

    expect(profileRepos(db, profileId, undefined, { syncForks: false })?.[0]?.pullPending).toBeUndefined();
    expect(profileRepos(db, profileId, undefined, { syncForks: true })?.[0]?.pullPending).toBe(true);
  });
});

describe("bulk sync fork wiring and post-sync refreshes", () => {
  const identityFor = (nameWithOwner: string): RepoIdentity => ({
    host: "github",
    hostname: "github.com",
    owner: nameWithOwner.split("/")[0]!,
    name: nameWithOwner.split("/")[1]!,
    nameWithOwner,
    visibility: "public",
    viewerCanPush: true,
    parent: {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://github.com/pingdotgg/t3code"
    }
  });

  function seedProfileWithRepos(db: DB): string {
    const profiles = new ProfileService(db);
    const profileId = profiles.create({ name: "dev", email: "dev@example.com", roots: [] }).id;
    for (const id of ["r-sync", "r-source", "r-tracked"]) {
      db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
        .run(id, profileId, id, `/repos/${id}`);
      db.prepare(
        "INSERT INTO worktrees (id, repo_id, branch, path, is_primary, missing) VALUES (?, ?, 'main', ?, 1, 0)"
      ).run(`${id}-wt`, id, `/repos/${id}`);
    }
    writeRemoteIdentity(db, "r-sync", {
      hostname: "github.com",
      nameWithOwner: "huntharo/t3code",
      viewerCanPush: true,
      parent: "pingdotgg/t3code"
    });
    setForkSyncRemotePref(db, "r-sync", "huntharo", false);
    return profileId;
  }

  function emptySummary(operationId: string, mode: "fetch" | "soft-pull"): BulkSyncSummary {
    return {
      operationId,
      mode,
      cancelled: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      counts: {
        repos: { success: 0, partial: 0, skipped: 0, failed: 0, cancelled: 0 },
        remotes: { fetched: 0, skipped: 0, failed: 0, cancelled: 0 },
        worktrees: { updated: 0, upToDate: 0, nothingToPull: 0, skipped: 0, failed: 0, cancelled: 0 }
      },
      results: []
    };
  }

  it("gates forkSync on enabled() and mode, forwards forkModes, and loads SQLite identities and prefs", async () => {
    const db = openDatabase(":memory:");
    const profileId = seedProfileWithRepos(db);
    let enabled = true;
    const captured: BulkSyncRepoInput[][] = [];
    bulkSyncOverride = async (_git, repos, options) => {
      captured.push(repos);
      return emptySummary(options.operationId, options.mode);
    };

    const bus = new CommandBus();
    registerBulkSyncHandlers(
      bus,
      db,
      { refreshWorktree: vi.fn(), refreshRepoWorktrees: vi.fn() },
      new WorktreeOperationQueue(),
      undefined,
      undefined,
      undefined,
      {
        enabled: () => enabled,
        readIdentity: (repoId) =>
          repoId === "r-sync" ? identityFor("pwrdrvr/t3code") : undefined,
        hostsForRemotes: () => ({ "ghe.example.com": "github" })
      }
    );

    // Enabled + soft-pull: forwards forkModes, parent, identities, prefs, hosts.
    await bus.dispatch("remote:bulkSync", {
      operationId: "op-enabled",
      profileId,
      mode: "soft-pull",
      forkModes: { "r-source": "source", "r-tracked": "tracked" }
    });
    const byId = new Map(captured[0]!.map((r) => [r.id, r]));
    expect(byId.get("r-sync")?.forkSync).toMatchObject({
      mode: "sync",
      parent: { hostname: "github.com", nameWithOwner: "pingdotgg/t3code" },
      hosts: { "ghe.example.com": "github" }
    });
    expect(byId.get("r-sync")?.forkSync?.remoteIdentities).toHaveLength(1);
    expect(byId.get("r-sync")?.forkSync?.forkSyncPrefs.get("huntharo")).toBe(false);
    expect(byId.get("r-source")?.forkSync?.mode).toBe("source");
    expect(byId.get("r-tracked")?.forkSync).toBeUndefined();

    // Fetch mode never attaches forkSync.
    await bus.dispatch("remote:bulkSync", {
      operationId: "op-fetch",
      profileId,
      mode: "fetch"
    });
    expect(captured[1]!.every((r) => r.forkSync === undefined)).toBe(true);

    // Disabled setting never attaches forkSync on soft-pull.
    enabled = false;
    await bus.dispatch("remote:bulkSync", {
      operationId: "op-disabled",
      profileId,
      mode: "soft-pull"
    });
    expect(captured[2]!.every((r) => r.forkSync === undefined)).toBe(true);
    db.close();
  });

  it("refreshes worktrees and emits graph:changed when local HEAD moved before a failed or cancelled fork push, and refreshes remote branches after fork push", async () => {
    const db = openDatabase(":memory:");
    const profileId = seedProfileWithRepos(db);
    const refreshRepoWorktrees = vi.fn().mockResolvedValue(undefined);
    const refreshRepoRemoteBranches = vi.fn().mockResolvedValue(ok(undefined));

    bulkSyncOverride = async (_git, repos, options) => {
      const repo = repos.find((r) => r.id === "r-sync")!;
      const repo2 = repos.find((r) => r.id === "r-source")!;
      // Case 1: local HEAD moved, then fork push failed (refsChanged = false).
      await options.onRepoCompleted?.(repo, {
        repoId: repo.id,
        name: repo.name,
        path: repo.path,
        outcome: "failed",
        refsChanged: false,
        remotes: [{ remote: "upstream", outcome: "fetched" }],
        worktrees: [
          {
            worktreeId: `${repo.id}-wt`,
            branch: "main",
            path: repo.path,
            outcome: "failed",
            reason: "fork_push_failed",
            beforeHead: "1".repeat(40),
            afterHead: "2".repeat(40),
            forkSource: "upstream/main",
            forkPushes: [{ outcome: "failed", remote: "origin", branch: "main", message: "rejected" }]
          }
        ]
      });
      // Case 2: local HEAD unchanged, sibling fork pushed (refsChanged = false).
      await options.onRepoCompleted?.(repo2, {
        repoId: repo2.id,
        name: repo2.name,
        path: repo2.path,
        outcome: "success",
        refsChanged: false,
        remotes: [{ remote: "upstream", outcome: "fetched" }],
        worktrees: [
          {
            worktreeId: `${repo2.id}-wt`,
            branch: "main",
            path: repo2.path,
            outcome: "updated",
            beforeHead: "2".repeat(40),
            afterHead: "2".repeat(40),
            forkSource: "upstream/main",
            forkPushes: [{ outcome: "pushed", remote: "huntharo", branch: "main" }]
          }
        ]
      });
      return emptySummary(options.operationId, options.mode);
    };

    const bus = new CommandBus();
    registerBulkSyncHandlers(
      bus,
      db,
      { refreshWorktree: vi.fn(), refreshRepoWorktrees },
      new WorktreeOperationQueue(),
      { refreshRepoRemoteBranches },
      undefined,
      undefined,
      { enabled: () => true }
    );

    await bus.dispatch("remote:bulkSync", {
      operationId: "op-refresh",
      profileId,
      mode: "soft-pull"
    });

    expect(refreshRepoWorktrees).toHaveBeenCalledWith("r-sync");
    expect(refreshRepoWorktrees).toHaveBeenCalledWith("r-source");
    expect(refreshRepoRemoteBranches).toHaveBeenCalledWith("r-source");
    expect(emitEvent).toHaveBeenCalledWith("graph:changed", { repoId: "r-sync" });
    expect(emitEvent).toHaveBeenCalledWith("graph:changed", { repoId: "r-source" });
    db.close();
  });

  it("catches rejections in fire-and-forget discoverSiblings without unhandled rejections", async () => {
    const db = openDatabase(":memory:");
    const profileId = seedProfileWithRepos(db);
    vi.mocked(execGit).mockImplementation(async (args) => {
      if (args[0] === "remote" && args[1] === "-v") {
        return ok({
          exitCode: 0,
          stdout: [
            "origin\tgit@github.com:pwrdrvr/t3code.git (fetch)",
            "origin\tgit@github.com:pwrdrvr/t3code.git (push)",
            "upstream\tgit@github.com:pingdotgg/t3code.git (fetch)",
            "upstream\tgit@github.com:pingdotgg/t3code.git (push)",
            "huntharo\tgit@github.com:huntharo/t3code.git (fetch)",
            "huntharo\tgit@github.com:huntharo/t3code.git (push)"
          ].join("\n"),
          stderr: ""
        });
      }
      return ok({ exitCode: 0, stdout: "", stderr: "" });
    });

    const ensureRemoteIdentities = vi.fn().mockRejectedValue(new Error("sqlite closed"));
    bulkSyncOverride = async (_git, repos, options) => {
      const repo = repos.find((r) => r.id === "r-sync")!;
      repo.forkSync?.onDiscoverSiblings?.("origin", "upstream");
      return emptySummary(options.operationId, options.mode);
    };

    const bus = new CommandBus();
    registerBulkSyncHandlers(
      bus,
      db,
      { refreshWorktree: vi.fn(), refreshRepoWorktrees: vi.fn() },
      new WorktreeOperationQueue(),
      undefined,
      undefined,
      undefined,
      {
        enabled: () => true,
        readIdentity: () => identityFor("pwrdrvr/t3code"),
        ensureRemoteIdentities
      }
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await bus.dispatch("remote:bulkSync", {
        operationId: "op-discover",
        profileId,
        mode: "soft-pull"
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      db.close();
    }

    expect(ensureRemoteIdentities).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    expect(logMain).toHaveBeenCalledWith(
      "debug",
      "forge",
      expect.stringContaining("sqlite closed")
    );
  });
});
