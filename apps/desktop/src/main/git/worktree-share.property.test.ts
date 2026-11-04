import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { ok, type Result } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import type { AppSettings, SettingsService } from "../settings/settings-service";
import type { GitExec, GitOutput } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";
import { registerBranchHandlers } from "./branch-handlers";
import { registerWorktreeLifecycleHandlers } from "./worktree-lifecycle-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import type { WorktreeStateService } from "./worktree-state";

const io = vi.hoisted(() => ({
  windowsPaths: false,
  git: null as unknown as GitExec,
  exists: (_path: string): boolean => false,
  share: null as unknown as (args: string[]) => Promise<{ stdout: string; stderr: string }>
}));
// Exercise Windows path rules on native hosts too, without touching a disk or
// changing process.platform. Only the path operations used by creation vary.
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  const paths = () => io.windowsPaths ? actual.win32 : actual;
  return {
    ...actual,
    resolve: (...parts: string[]) => paths().resolve(...parts),
    join: (...parts: string[]) => paths().join(...parts),
    dirname: (path: string) => paths().dirname(path),
    basename: (path: string, suffix?: string) => paths().basename(path, suffix)
  };
});
vi.mock("../ipc", () => ({ emitEvent: () => undefined }));
vi.mock("../logs", () => ({ logMain: () => undefined }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  realpath: async (path: string) => resolve(path),
  mkdir: async () => undefined,
  lstat: async (path: string) => {
    if (!io.exists(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return {};
  }
}));
vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => undefined, {
    [promisify.custom]: (_binary: string, args: string[]) => io.share(args)
  });
  return { ...await original<typeof import("node:child_process")>(), execFile };
});
vi.mock("./dugite", async (original) => ({
  ...await original<typeof import("./dugite")>(),
  execGit: (...args: Parameters<GitExec>) => io.git(...args),
  gitLaunch: () => ({ binary: "fixture-git", env: {} })
}));

type Request = {
  id: number;
  repo: number;
  branch: number;
  kind: "worktree" | "branch";
  ending: "shared" | "fallback" | "unavailable" | "failure";
};
type Registration = { repo: number; branch: string; owner: number };
const requestArb = fc.record({
  repo: fc.integer({ min: 0, max: 1 }),
  branch: fc.integer({ min: 0, max: 1 }),
  kind: fc.constantFrom("worktree" as const, "branch" as const),
  ending: fc.constantFrom("shared" as const, "fallback" as const, "unavailable" as const, "failure" as const)
});
const fixtureRoot = () => io.windowsPaths ? "D:\\fixture-share" : resolve("/fixture-share");
const managed = () => join(fixtureRoot(), "managed");
const primary = (repo: number) => join(fixtureRoot(), `repo-${repo}`);
const linked = (repo: number) => join(fixtureRoot(), `linked-${repo}`);
const destination = (request: Request) => join(managed(), `repo-${request.repo}`, `feature-${request.branch}`);

/** The model has atomic registration, like Git. Only completion of I/O is
 * scheduled; production handlers, the shared queue and rollback run unchanged. */
function harness(scheduler: fc.Scheduler, settings: AppSettings) {
  const context = new AsyncLocalStorage<Request>();
  const registrations = new Map<string, Registration>();
  const branches = [new Set(["main", "donor"]), new Set(["main", "donor"])];
  const active = [0, 0];
  const maxActive = [0, 0];
  const invocations: Array<{ request: Request; args: string[] }> = [];
  for (const repo of [0, 1]) {
    registrations.set(primary(repo), { repo, branch: "main", owner: -1 });
    registrations.set(linked(repo), { repo, branch: "donor", owner: -1 });
  }
  io.exists = (path) => registrations.has(path);
  const current = (): Request => {
    const request = context.getStore();
    if (!request) throw new Error("I/O outside a create request");
    return request;
  };
  const register = (request: Request, path: string, branch: string): boolean => {
    if (registrations.has(path) || branches[request.repo]!.has(branch)) return false;
    registrations.set(path, { repo: request.repo, branch, owner: request.id });
    branches[request.repo]!.add(branch);
    return true;
  };
  const output = (stdout = "", exitCode = 0, stderr = ""): GitOutput => ({ stdout, exitCode, stderr });
  io.git = async (args) => {
    const request = current();
    await scheduler.schedule(Promise.resolve(), `git:${request.id}:${args.slice(0, 2).join(" ")}`);
    if (args[0] !== "worktree") throw new Error(`unexpected git command: ${args}`);
    if (args[1] === "list") {
      return ok(output([...registrations].filter(([, row]) => row.repo === request.repo).map(([path, row]) =>
        `worktree ${path}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/${row.branch}\n\n`
      ).join("")));
    }
    if (args[1] === "add") {
      const branch = args[args.indexOf("-b") + 1]!;
      const path = args[args.indexOf("-b") + 2]!;
      return ok(register(request, path, branch) ? output() : output("", 1, "worktree already exists"));
    }
    if (args[1] === "remove") {
      registrations.delete(args.at(-1)!);
      return ok(output());
    }
    throw new Error(`unexpected worktree command: ${args}`);
  };
  io.share = async (args) => {
    const request = current();
    invocations.push({ request, args });
    active[request.repo]!++;
    maxActive[request.repo] = Math.max(maxActive[request.repo]!, active[request.repo]!);
    try {
      await scheduler.schedule(Promise.resolve(), `CLI register:${request.id}`);
      if (request.ending === "unavailable") return { stdout: '{"fallback":"git-checkout"}', stderr: "" };
      if (!register(request, args[args.indexOf("--") + 1]!, args[args.indexOf("-b") + 1]!)) {
        throw Object.assign(new Error("collision"), { code: 4, stderr: "worktree already exists" });
      }
      await scheduler.schedule(Promise.resolve(), `CLI checkout:${request.id}`);
      if (request.ending === "failure") throw Object.assign(new Error("checkout failed"), { code: 3, stderr: "checkout failed" });
      return { stdout: JSON.stringify({ fallback: request.ending === "fallback" ? "git-checkout" : "none" }), stderr: "" };
    } finally {
      active[request.repo]!--;
    }
  };
  const db = {
    prepare: (sql: string) => ({
      get: (id: string, branch?: string) => {
        const repo = Number(id.slice(1));
        if (sql.includes("SELECT id FROM worktrees")) {
          const path = [...registrations].find(([, row]) => row.repo === repo && row.branch === branch)?.[0];
          return path === undefined ? undefined : { id: path };
        }
        if (sql.includes("JOIN repos")) return { path: linked(repo), repo_id: `r${repo}`, repo_name: `repo-${repo}`, repo_path: primary(repo), profile_id: `p${repo}` };
        return { id, name: `repo-${repo}`, path: primary(repo), profile_id: `p${repo}` };
      },
      all: () => []
    })
  } as unknown as DB;
  const indexer = { refreshRepoWorktrees: async () => undefined } as unknown as RepoIndexer;
  const service = { get: () => ({ worktreeRoot: managed(), ...settings }) } as SettingsService;
  const operations = new WorktreeOperationQueue();
  const bus = new CommandBus();
  registerWorktreeLifecycleHandlers(bus, db, indexer, service, {} as WorktreeStateService, operations);
  registerBranchHandlers(bus, db, indexer, { refreshWorktree: async () => undefined, refreshRepoWorktrees: async () => undefined }, operations, service);
  const dispatch = (request: Request): Promise<Result<unknown>> => context.run(request, () => request.kind === "worktree"
    ? bus.dispatch("worktree:create", { repoId: `r${request.repo}`, branch: `feature-${request.branch}`, newBranch: true, startPoint: "main" })
    : bus.dispatch("branch:create", { worktreeId: `w${request.repo}`, branch: `feature-${request.branch}`, startPoint: "main", checkout: "new-worktree" }));
  return { dispatch, registrations, maxActive, invocations };
}

describe.each([
  { name: "native", windowsPaths: false },
  { name: "Windows", windowsPaths: true }
])("worktree creation model ($name paths)", ({ windowsPaths }) => {
  beforeEach(() => { io.windowsPaths = windowsPaths; });
  afterEach(() => { io.windowsPaths = false; });

  // Windows CI shrank the failure to one ordinary create with sharing off:
  // the model looked up a POSIX key after the handler registered a Windows path.
  it("finds a successful ordinary checkout under its native destination path", async () => {
    const scheduler = fc.schedulerFor([1]);
    const request: Request = { id: 0, repo: 0, branch: 0, kind: "worktree", ending: "shared" };
    const real = harness(scheduler, { worktreeReflink: "off", worktreeSeedCargoTarget: "off" });
    expect(await scheduler.waitFor(real.dispatch(request))).toMatchObject({ ok: true });
    expect(real.registrations.get(destination(request))?.owner).toBe(0);
  });

  it("serializes every repository and preserves successful checkouts across arbitrary competing failures", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(requestArb, { minLength: 2, maxLength: 6 }), async (scheduler, generated) => {
      const real = harness(scheduler, { worktreeReflink: "on" });
      const requests = generated.map((request, id) => ({ ...request, id }));
      const pending = requests.map((request) => scheduler.schedule(Promise.resolve(), `submit:${request.id}`).then(() => real.dispatch(request)));
      const results = await scheduler.waitFor(Promise.all(pending));
      for (const active of real.maxActive) expect(active).toBeLessThanOrEqual(1);
      const winners = new Set<number>();
      for (const [index, result] of results.entries()) {
        if (!result.ok) continue;
        const request = requests[index]!;
        winners.add(request.id);
        expect(real.registrations.get(destination(request))?.owner).toBe(request.id);
      }
      for (const row of real.registrations.values()) {
        if (row.owner !== -1) expect(winners.has(row.owner)).toBe(true);
      }
    }), { numRuns: 50 });
  });

  it("both creation entry points obey the same sharing settings and donor rule", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), requestArb, fc.boolean(), fc.boolean(), async (scheduler, generated, source, seed) => {
      const request: Request = { ...generated, id: 0, ending: "shared" };
      const real = harness(scheduler, { worktreeReflink: source ? "on" : "off", worktreeSeedCargoTarget: seed ? "on" : "off" });
      expect(await scheduler.waitFor(real.dispatch(request))).toMatchObject({ ok: true });
      expect(real.invocations).toHaveLength(source ? 1 : 0);
      if (source) {
        const args = real.invocations[0]!.args;
        expect(args.includes("--seed-cargo")).toBe(seed);
        expect(args[args.indexOf("--donor") + 1]).toBe(request.kind === "branch" ? linked(request.repo) : primary(request.repo));
        expect(args.at(-1)).toBe("main");
      }
      expect(real.registrations.get(destination(request))?.owner).toBe(0);
    }), { numRuns: 50 });
  });
});
