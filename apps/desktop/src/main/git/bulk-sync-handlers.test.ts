import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { execGit } from "./dugite";
import { profileRepos, registerBulkSyncHandlers } from "./bulk-sync-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./dugite", async (importOriginal) => ({
  ...await importOriginal<typeof import("./dugite")>(),
  execGit: vi.fn()
}));

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
  // its present checkouts has stored state that is behind its upstream, not
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
    seed(theirs, "g-theirs", [{ ...clean, behind: 5 }]);

    const repos = profileRepos(db, mine);
    expect(repos?.map((repo) => [repo.id, repo.pullPending === true])).toEqual([
      ["a-current", false],
      ["b-behind", true],
      ["c-dirty", false],
      ["d-diverged", false],
      ["e-no-upstream", false],
      ["f-gone", false]
    ]);
    // Worktree inputs carry no stored-state columns.
    expect(repos?.find((repo) => repo.id === "b-behind")?.worktrees).toEqual([
      { id: "b-behind-wt0", branch: "b0", path: "/checkouts/b-behind/0" },
      { id: "b-behind-wt1", branch: "b1", path: "/checkouts/b-behind/1" }
    ]);
    expect(profileRepos(db, theirs)?.map((repo) => repo.pullPending)).toEqual([true]);
  });
});
