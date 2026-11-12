import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { SettingsService } from "../settings/settings-service";
import { registerBranchHandlers } from "./branch-handlers";
import type { GitExec } from "./dugite";
import type { WorktreeInfo } from "./git-service";
import { registerRemoteHandlers } from "./remote-handlers";
import { registerRepoRemovalHandlers } from "./repo-removal-handlers";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";
import { registerWorktreeLifecycleHandlers } from "./worktree-lifecycle-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { WorktreeStateService } from "./worktree-state";

/**
 * Model test for the repository/worktree queues: the real handlers take their
 * real locks, and only Git is replaced. Each stubbed Git command says which
 * scopes it touches and finishes when fast-check's scheduler decides, as do
 * the requests' arrivals. Rules, for every ordering:
 *
 * - every request settles, without tripping the queue's lock-order guard;
 * - no two Git commands touch the same repository or worktree at once.
 *
 * Against #542's parent it deadlocks within a few runs (shrunk, for example,
 * to `pull, repairForkTracking, fetchRepo`); #486's parent removal trips the
 * lock-order guard on the first run.
 */

type Scope = string;
type Harness = {
  /** Run one stubbed Git command that touches `scopes`. */
  git: <T>(label: string, scopes: Scope[], value: T) => Promise<T>;
  scopesOfPath: (path: string) => Scope[];
};

const { harness } = vi.hoisted(() => ({
  harness: { current: null as Harness | null }
}));

// Outside a run (the fixture's own indexing) every mock is the real function.
function stubbed<A extends unknown[], R>(
  actual: (...args: A) => Promise<R>,
  stub: (h: Harness, ...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args) => {
    const h = harness.current;
    return h === null ? actual(...args) : stub(h, ...args);
  };
}

vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  const worktreeScopes = (h: Harness, path: string): Scope[] => h.scopesOfPath(path);
  const repoScope = (h: Harness, path: string): Scope[] =>
    h.scopesOfPath(path).filter((s) => s.startsWith("repository:"));
  return {
    ...actual,
    // Pull fetches (repository refs), moves the checkout and may stash
    // (shared by every worktree): both scopes.
    pullFastForward: stubbed(actual.pullFastForward, (h, _git, path) =>
      h.git("pull", worktreeScopes(h, path), ok({
        fastForwarded: true, stashed: false, reappliedWithConflicts: false
      }))),
    fetchRemote: stubbed(actual.fetchRemote, (h, _git, path) =>
      h.git("fetch", repoScope(h, path), ok(undefined))),
    fetchNamedRemotes: stubbed(actual.fetchNamedRemotes, (h, _git, path) =>
      h.git("fetch", repoScope(h, path), ok(undefined))),
    fetchAllRemotes: stubbed(actual.fetchAllRemotes, (h, _git, path) =>
      h.git("fetch", repoScope(h, path), ok(undefined))),
    fetchNamedRemote: stubbed(actual.fetchNamedRemote, (h, _git, path) =>
      h.git("fetch", repoScope(h, path), ok(undefined))),
    // A config read: touches nothing another command writes.
    forkFetchRemotes: stubbed(actual.forkFetchRemotes, (h) =>
      h.git("remote config", [], null)),
    switchBranch: stubbed(actual.switchBranch, (h, _git, path) =>
      h.git("switch", worktreeScopes(h, path).filter((s) => s.startsWith("worktree:")), ok(undefined))),
    switchBranchCarryingChanges: stubbed(actual.switchBranchCarryingChanges, (h, _git, path) =>
      h.git("switch merge", worktreeScopes(h, path), ok({ carried: true }))),
    switchBranchLeavingChanges: stubbed(actual.switchBranchLeavingChanges, (h, _git, path) =>
      h.git("switch leave", worktreeScopes(h, path), ok({ left: true }))),
    worktreeRemove: stubbed(actual.worktreeRemove, (h, _git, _repo, path) =>
      h.git("worktree remove", worktreeScopes(h, path).filter((s) => s.startsWith("worktree:")), ok(undefined))),
    listWorktrees: stubbed(actual.listWorktrees, (h) =>
      h.git("worktree list", [], ok(fixtureWorktrees)))
  };
});
vi.mock("./fork-tracking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fork-tracking")>();
  return {
    ...actual,
    inspectForkTracking: stubbed(actual.inspectForkTracking, (h, _git, path) =>
      h.git("inspect fork tracking", h.scopesOfPath(path), ok(null))),
    repairForkTracking: stubbed(actual.repairForkTracking, (h, _git, path) =>
      h.git("repair fork tracking", h.scopesOfPath(path), ok(null)))
  };
});
vi.mock("./branch-tracking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./branch-tracking")>();
  return {
    ...actual,
    retrackBranch: stubbed(actual.retrackBranch, (h, _git, path) =>
      h.git("retrack", h.scopesOfPath(path), ok({ moved: false, copied: null })))
  };
});
vi.mock("./auto-remote-check", () => ({
  checkRemoteTips: vi.fn(async () => new Map()),
  ensureForkParentRemote: vi.fn(async () => ok(undefined))
}));
// The tag check after a Fetch or Pull is the same kind of background check:
// unlocked by design and never awaited. With real Git it would still be
// running in the fixture when afterAll deletes it, which Windows refuses
// (EPERM). Every run here answers "nothing to check".
vi.mock("./tag-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tag-sources")>();
  return {
    ...actual,
    tagSourcesFor: () => ({
      source: async () =>
        err({ kind: "git", code: "not_modeled", message: "Tag checks are not part of this model." }),
      recountPublisher: async () => ok(false)
    })
  };
});
vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

const systemGit = createSystemGit();
let fixtureWorktrees: WorktreeInfo[] = [];
let root = "";
let db: DB;
let repoId = "";
const worktreeIds: Record<"primary" | "linked", string> = { primary: "", linked: "" };
const pathToWorktreeId = new Map<string, string>();

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-queue-model-")));
  const repoPath = join(root, "harbor");
  execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
  git(repoPath, ["config", "user.email", "t@t.com"]);
  git(repoPath, ["config", "user.name", "Tester"]);
  writeFileSync(join(repoPath, "a.txt"), "1\n");
  git(repoPath, ["add", "a.txt"]);
  git(repoPath, ["commit", "-q", "-m", "baseline"]);
  git(repoPath, ["worktree", "add", "-q", "-b", "feature", join(root, "wt-feature")]);

  db = openDatabase(":memory:");
  const profileId = new ProfileService(db).create({ name: "Work", email: "t@t.com" }).id;
  const indexer = new RepoIndexer(db, systemGit);
  const added = await indexer.indexRepoAt(profileId, repoPath);
  if (!added.ok) throw new Error(added.error.message);
  repoId = added.value.id;
  await indexer.refreshRepoWorktrees(repoId);
  const rows = db
    .prepare("SELECT id, path, is_primary FROM worktrees WHERE repo_id = ?")
    .all(repoId) as { id: string; path: string; is_primary: number }[];
  // Paths exactly as the indexer stored them (git's spelling), never rebuilt.
  for (const row of rows) {
    worktreeIds[row.is_primary === 1 ? "primary" : "linked"] = row.id;
    pathToWorktreeId.set(row.path, row.id);
  }
  fixtureWorktrees = rows
    .sort((a, b) => b.is_primary - a.is_primary)
    .map((row) => ({
      path: row.path, branch: row.is_primary === 1 ? "main" : "feature", head: "1".repeat(40),
      detached: false, bare: false, prunable: false, locked: false
    }));
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

/** Records every lock-order refusal: handlers turn a throw into an error
 *  result, which would otherwise read as an ordinary failed request. */
class RecordingQueue extends WorktreeOperationQueue {
  refusals: string[] = [];
  override async run<T>(worktreeId: string, operation: () => Promise<T>): Promise<T> {
    return this.record(super.run(worktreeId, operation));
  }
  override async runRepository<T>(repoId: string, operation: () => Promise<T>): Promise<T> {
    return this.record(super.runRepository(repoId, operation));
  }
  private async record<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/queue scopes are not reentrant|before worktree scope/.test(message)) {
        this.refusals.push(message);
      }
      throw cause;
    }
  }
}

type Target = "primary" | "linked";
type Request =
  | { kind: "pull" | "fetch" | "probe" | "inspectForkTracking" | "repairForkTracking"
      | "retrack" | "switchMerge" | "switchLeave"; target: Target }
  | { kind: "fetchRepo" | "removeWorktree" | "removeRepository" };

const target = fc.constantFrom<Target>("primary", "linked");
const request: fc.Arbitrary<Request> = fc.oneof(
  fc.record({
    kind: fc.constantFrom(
      "pull", "fetch", "probe", "inspectForkTracking", "repairForkTracking",
      "retrack", "switchMerge", "switchLeave"
    ) as fc.Arbitrary<Exclude<Request, { target?: never }>["kind"]>,
    target
  }) as fc.Arbitrary<Request>,
  fc.record({
    kind: fc.constantFrom("fetchRepo", "removeWorktree", "removeRepository") as
      fc.Arbitrary<"fetchRepo" | "removeWorktree" | "removeRepository">
  })
);

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

it("settles every request and never lets two Git commands share a scope", async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(request, { minLength: 1, maxLength: 8 }), async (s, requests) => {
      // Scope -> the request whose Git command holds it. One request may run
      // several commands at once inside its own lock (a probe's reads do).
      const running = new Map<Scope, { owner: number; label: string; count: number }>();
      const overlaps: string[] = [];
      const probeOf = new AsyncLocalStorage<string>();
      const requestOf = new AsyncLocalStorage<number>();
      harness.current = {
        scopesOfPath: (path) => {
          const id = pathToWorktreeId.get(path);
          return [`repository:${repoId}`, ...(id === undefined ? [] : [`worktree:${id}`])];
        },
        git: (label, scopes, value) => {
          const owner = requestOf.getStore() ?? -1;
          for (const scope of scopes) {
            const holder = running.get(scope);
            if (holder !== undefined && holder.owner !== owner) {
              overlaps.push(`${label} ran during ${holder.label} on ${scope}`);
            }
          }
          // Count every command per scope and owner, overlapping or not, so a
          // later overlap with this one is still seen.
          for (const scope of scopes) {
            const holder = running.get(scope);
            if (holder?.owner === owner) holder.count += 1;
            else running.set(scope, { owner, label, count: 1 });
          }
          return s.schedule(Promise.resolve(value), label).then((result) => {
            for (const scope of scopes) {
              const holder = running.get(scope);
              if (holder?.owner === owner && --holder.count === 0) running.delete(scope);
            }
            return result;
          });
        }
      };
      try {
        const operations = new RecordingQueue();
        // A status probe runs in its checkout (reads in the main checkout only
        // resolve the default branch), so it touches its own worktree.
        const probeGit: GitExec = (_args, _cwd) => {
          const id = probeOf.getStore();
          return harness.current!.git(
            "status probe",
            id === undefined ? [] : [`worktree:${id}`],
            ok({ stdout: "", stderr: "", exitCode: 0 })
          );
        };
        // Removal's review only reads.
        const reviewGit: GitExec = () =>
          harness.current!.git("removal review", [], ok({ stdout: "", stderr: "", exitCode: 0 }));
        const state = new WorktreeStateService(db, probeGit, operations);
        const indexer = {
          refreshRepoWorktrees: async () => ok([]),
          refreshRepoRemoteBranches: async () => ok(undefined),
          forgetWorktree: () => undefined,
          deleteRepo: () => undefined
        } as unknown as RepoIndexer;
        const refresher = { refreshWorktree: async () => {}, refreshRepoWorktrees: async () => {} };
        const bus = new CommandBus();
        registerRemoteHandlers(bus, db, refresher, operations);
        registerBranchHandlers(bus, db, indexer, refresher, operations, {} as SettingsService);
        registerWorktreeLifecycleHandlers(bus, db, indexer, {} as SettingsService, state, operations);
        registerRepoRemovalHandlers(bus, {
          db, git: reviewGit, indexer, state, operations,
          // Moving a folder to the Trash touches that checkout; the main
          // checkout holds `.git`, so the whole repository with it.
          trash: (path) => harness.current!.git(
            "trash",
            pathToWorktreeId.get(path) === worktreeIds.primary
              ? harness.current!.scopesOfPath(path)
              : harness.current!.scopesOfPath(path).filter((x) => x.startsWith("worktree:")),
            undefined
          )
        });

        const send = (r: Request): Promise<unknown> => {
          const worktreeId = "target" in r ? worktreeIds[r.target] : "";
          switch (r.kind) {
            case "pull": return bus.dispatch("remote:pull", { worktreeId });
            case "fetch": return bus.dispatch("remote:fetch", { worktreeId });
            case "fetchRepo": return bus.dispatch("remote:fetchRepo", { repoId });
            case "probe": return probeOf.run(worktreeId, () => state.compute(worktreeId));
            case "inspectForkTracking": return bus.dispatch("remote:inspectForkTracking", { worktreeId });
            case "repairForkTracking":
              return bus.dispatch("remote:repairForkTracking", { worktreeId, branch: "main", upstream: "upstream/main" });
            case "retrack":
              return bus.dispatch("remote:retrack", {
                worktreeId, branch: "main", remote: "origin", remoteBranch: "main",
                head: "1".repeat(40), targetHead: "1".repeat(40), upstreamRef: null, move: "none"
              });
            case "switchMerge": return bus.dispatch("branch:switch", { worktreeId, branch: "other", changes: "merge" });
            case "switchLeave": return bus.dispatch("branch:switch", { worktreeId, branch: "other", changes: "leave" });
            case "removeWorktree": return bus.dispatch("worktree:removeMany", { worktreeIds: [worktreeIds.linked] });
            case "removeRepository":
              return bus.dispatch("repo:remove", {
                operationId: "op", repoId, decisions: { checkouts: {}, branches: {} }
              });
          }
        };

        const settled = requests.map(() => false);
        const failures: string[] = [];
        requests.forEach((r, index) => {
          // Arrivals interleave with Git finishing, in the scheduler's order.
          void s.schedule(Promise.resolve(), `arrive ${r.kind}`)
            .then(() => requestOf.run(index, () => send(r)))
            .then((result) => {
              // A probe answers a snapshot, or nothing while its checkout is
              // being removed; every command answers a Result.
              if (r.kind !== "probe" && (result as { ok: boolean }).ok !== true) {
                failures.push(`${r.kind}: ${JSON.stringify(result)}`);
              }
            }, (cause: unknown) => { failures.push(`${r.kind}: ${String(cause)}`); })
            .finally(() => { settled[index] = true; });
        });

        // Drain: release scheduled work until nothing is left. Removal's
        // review measures folders with real fs calls, outside the scheduler,
        // so an empty schedule is only "stuck" once that I/O has had time:
        // about two seconds, which a slow Windows disk still fits in. Only a
        // deadlocked run waits that long.
        for (let idle = 0; idle < 40 && settled.includes(false);) {
          await s.waitIdle();
          await nextTurn();
          if (s.count() > 0) { idle = 0; continue; }
          idle += 1;
          await pause(idle < 10 ? 2 : 50);
        }

        const stuck = requests.filter((_, i) => !settled[i]).map((r) => r.kind);
        expect(stuck, "requests that never settled (deadlock)").toEqual([]);
        expect(operations.refusals).toEqual([]);
        expect(failures).toEqual([]);
        expect(overlaps).toEqual([]);
      } finally {
        harness.current = null;
      }
    }),
    { numRuns: 100 }
  );
});
