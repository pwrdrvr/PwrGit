import { existsSync } from "node:fs";
import { lstat, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import type { Profile, Repo, Result } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { GitExec } from "./dugite";
import { GhStackCatalogStore, NativeStackLocks } from "./stack-catalog-store";
import { commit, git, gitEnvironment, withStack } from "./stack-engine/fixture.test-support";
import { StackReader, stackRunner } from "./stack-reader";
import { registerStackReadHandlers } from "./stack-read-handlers";
import { registerStackWriteHandlers } from "./stack-write-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { createSystemGit } from "./test-support/system-git";

const native = fileURLToPath(new URL(`../../../build/mcp/pwrgit-mcp${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const execute = createSystemGit({ env: gitEnvironment });

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup(cwd: string, common: string, gitExec = execute, profile: Profile | null = null) {
  const bus = new CommandBus();
  const request = { repoId: "orbit", profileId: "first" };
  const repo: Repo = {
    name: "Orbit", id: request.repoId, profileId: request.profileId, path: cwd, pinned: false, worktrees: [],
  };
  const reader = new StackReader(stackRunner(execute), new NativeStackLocks(() => native), async () => ({
    forge: "github", fetchedAt: null, truncated: false, entries: [], remotes: [],
  }), () => undefined);
  const find = (id: string) => id === repo.id ? repo : null;
  registerStackReadHandlers(bus, find, reader);
  registerStackWriteHandlers(bus, {
    git: gitExec, queue: new WorktreeOperationQueue(), reader,
    findRepo: find, findProfile: () => profile, changed: async () => undefined,
  });
  const snapshot = value(await bus.dispatch("stack:list", request));
  return { bus, request, repo, reader, stackId: snapshot.stacks[0]?.id ?? "", catalog: join(common, "gh-stack") };
}

test.skipIf(!existsSync(native))("conflict pause and continuation preserve official branch tips until the local transaction (requires pnpm build:native)", () =>
  withStack(async ({ cwd, commonDir, initial, bottom, top }) => {
    await commit(cwd, "bottom.txt", "different upstream content\n");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    expect(plan.steps[0].conflict?.files).toEqual(["bottom.txt"]);
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    expect(pause.phase).toBe("resolving");
    expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(`${bottom}\n${top}`);
    expect(existsSync(join(commonDir, "pwrgit-stack-op.json"))).toBe(true);

    await writeFile(join(pause.worktreePath, "bottom.txt"), "resolved content\n");
    await git(pause.worktreePath, "add", "bottom.txt");
    await git(pause.worktreePath, "-c", "core.editor=true", "rebase", "--continue");
    const status = value(await bus.dispatch("stack:conflict", { ...request, stackId }));
    expect(status?.phase).toBe("resolved");
    const result = value(await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id }));
    expect(result.applied?.plan.steps[0].resolved).toBe(true);
    expect(await git(cwd, "show", "bottom:bottom.txt")).toBe("resolved content");
    await git(cwd, "merge-base", "--is-ancestor", "bottom", "top");
    expect(existsSync(join(commonDir, "pwrgit-stack-op.json"))).toBe(false);
    expect(existsSync(pause.worktreePath)).toBe(false);
    value(await bus.dispatch("stack:undo", { ...request, operationId: plan.id }));
    expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(`${bottom}\n${top}`);
  })
);

test.skipIf(!existsSync(native))("add, detach and undo use the planned refs while forget only edits the catalog (requires pnpm build:native)", () =>
  withStack(async ({ cwd, commonDir, initial, base, bottom, top }) => {
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId, catalog } = await setup(cwd, commonDir);
    const add = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "add_branch", branch: "third" } }));
    value(await bus.dispatch("stack:apply", { ...request, planId: add.id }));
    expect(await git(cwd, "rev-parse", "third")).toBe(top);
    value(await bus.dispatch("stack:undo", { ...request, operationId: add.id }));
    expect((await execute(["show-ref", "--exists", "refs/heads/third"], cwd))).toMatchObject({ ok: true, value: { exitCode: 2 } });

    const detach = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "remove", branch: "bottom", mode: "detach" } }));
    value(await bus.dispatch("stack:apply", { ...request, planId: detach.id }));
    expect(await git(cwd, "rev-parse", "bottom")).toBe(bottom);
    expect(await git(cwd, "log", "--format=%s", `${base}..top`)).toBe("top.txt");
    value(await bus.dispatch("stack:undo", { ...request, operationId: detach.id }));

    const forget = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "remove", branch: "bottom", mode: "forget" } }));
    expect(forget.moves).toEqual([]);
    value(await bus.dispatch("stack:apply", { ...request, planId: forget.id }));
    expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(`${bottom}\n${top}`);
    expect(JSON.parse(await readFile(catalog, "utf8"))).toMatchObject({ stacks: [{ branches: [{ branch: "top", base }] }] });
  })
);

test.skipIf(!existsSync(native))("aborting and checking out the planned parent cannot publish a resolution", () =>
  withStack(async ({ cwd, commonDir, initial, bottom }) => {
    const parent = await commit(cwd, "bottom.txt", "upstream conflict");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      await git(pause.worktreePath, "rebase", "--abort");
      await git(pause.worktreePath, "switch", "--detach", parent);
      expect((await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id })).ok).toBe(false);
      expect(await git(cwd, "rev-parse", "bottom")).toBe(bottom);
    } finally {
      if (existsSync(pause.worktreePath)) await git(cwd, "worktree", "remove", pause.worktreePath);
    }
  })
);

test.skipIf(!existsSync(native))("starting a conflicting stack replay never edits an existing checkout", () =>
  withStack(async ({ cwd, commonDir, initial }) => {
    await commit(cwd, "bottom.txt", "upstream conflict");
    await commit(cwd, "local.secret", "public parent contents");
    const holder = join(cwd, "holder");
    await git(cwd, "worktree", "add", holder, "bottom");
    await writeFile(join(commonDir, "info", "exclude"), "local.secret\n");
    await writeFile(join(holder, "local.secret"), "private local bytes");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      expect(await readFile(join(holder, "local.secret"), "utf8")).toBe("private local bytes");
      expect(await git(holder, "symbolic-ref", "--short", "HEAD")).toBe("bottom");
    } finally {
      await git(pause.worktreePath, "rebase", "--abort");
      if (pause.worktreePath !== holder) await git(cwd, "worktree", "remove", pause.worktreePath);
    }
  })
);

test.skipIf(!existsSync(native))("recovery closes a journal whose worktree setup was interrupted", () =>
  withStack(async ({ cwd, commonDir, initial, bottom, top }) => {
    await commit(cwd, "bottom.txt", "upstream conflict");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, repo, reader, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    const { store } = await reader.location(repo);
    const interrupted = await store.readResolutionJournal(commonDir);
    await git(pause.worktreePath, "rebase", "--abort");
    // Reconstruct the durable state before Git created either the worktree or its branch.
    await git(cwd, "worktree", "remove", pause.worktreePath);
    if (interrupted?.resolutionBranch) await git(cwd, "branch", "-D", interrupted.resolutionBranch);
    await store.writeJournal(commonDir, interrupted);
    expect(value(await bus.dispatch("stack:list", request)).recoveryAvailable).toBe(true);
    value(await bus.dispatch("stack:recover", request));
    expect(await store.readJournal(commonDir)).toBeUndefined();
    expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(`${bottom}\n${top}`);
  })
);

test.skipIf(!existsSync(native) || process.platform === "win32")("a symlink spelling of the resolution checkout still identifies the indexed worktree", () =>
  withStack(async ({ cwd, commonDir, initial }) => {
    await commit(cwd, "bottom.txt", "upstream conflict");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, repo, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      const alias = join(cwd, "resolution-alias");
      await symlink(pause.worktreePath, alias, "dir");
      repo.worktrees = [{ id: "resolution", path: alias } as Repo["worktrees"][number]];
      const status = value(await bus.dispatch("stack:conflict", { ...request, stackId }));
      expect(status?.worktreeId).toBe("resolution");
      expect(status?.worktreePath).toBe(await realpath(pause.worktreePath));
    } finally {
      await git(pause.worktreePath, "rebase", "--abort");
      value(await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id }));
    }
  })
);

test.skipIf(!existsSync(native))("a stale completed rebase can be closed without losing its commit", () =>
  withStack(async ({ cwd, commonDir, initial, bottom }) => {
    await commit(cwd, "bottom.txt", "upstream conflict");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      await writeFile(join(pause.worktreePath, "bottom.txt"), "resolved content");
      await git(pause.worktreePath, "add", "bottom.txt");
      await git(pause.worktreePath, "-c", "core.editor=true", "rebase", "--continue");
      const resolved = await git(pause.worktreePath, "rev-parse", "HEAD");
      await commit(cwd, "advanced.txt", "the parent moved");
      expect((await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id })).ok).toBe(false);
      value(await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id, close: true }));
      expect(await git(pause.worktreePath, "rev-parse", "HEAD")).toBe(resolved);
      expect(await git(cwd, "rev-parse", "bottom")).toBe(bottom);
      expect(value(await bus.dispatch("stack:list", request)).busy).toBeUndefined();
      expect((await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } })).ok).toBe(true);
    } finally {
      if (existsSync(pause.worktreePath)) await git(cwd, "worktree", "remove", pause.worktreePath);
    }
  })
);

test.skipIf(!existsSync(native))("recovery finds and cleans a resolved worktree after Git commits but loses its result", () =>
  withStack(async ({ cwd, commonDir, initial, bottom }) => {
    await commit(cwd, "bottom.txt", "upstream conflict");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    let loseResult = false;
    const injected: GitExec = async (args, directory, options) => {
      const result = await execute(args, directory, options);
      if (loseResult && args[0] === "update-ref" && args[1] === "--stdin" && result.ok && result.value.exitCode === 0) {
        loseResult = false;
        throw new Error("simulated crash after ref commit");
      }
      return result;
    };
    const { bus, request, repo, reader, stackId } = await setup(cwd, commonDir, injected);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      await writeFile(join(pause.worktreePath, "bottom.txt"), "resolved content");
      await git(pause.worktreePath, "add", "bottom.txt");
      await git(pause.worktreePath, "-c", "core.editor=true", "rebase", "--continue");
      const resolved = await git(pause.worktreePath, "rev-parse", "HEAD");
      loseResult = true;
      expect((await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id })).ok).toBe(false);
      expect(await git(cwd, "rev-parse", "bottom")).toBe(resolved);
      const { store } = await reader.location(repo);
      expect(await store.readApplyJournal(commonDir)).toMatchObject({ resolution: { journal: { path: pause.worktreePath }, tip: resolved } });
      value(await bus.dispatch("stack:recover", request));
      expect(await store.readJournal(commonDir)).toBeUndefined();
      await expect(lstat(pause.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      value(await bus.dispatch("stack:undo", { ...request, operationId: plan.id }));
      expect(await git(cwd, "rev-parse", "bottom")).toBe(bottom);
    } finally {
      if (existsSync(pause.worktreePath)) await git(cwd, "worktree", "remove", pause.worktreePath);
    }
  })
);

test.skipIf(!existsSync(native))("the last forgotten stack still exposes and completes empty-catalog recovery", () =>
  withStack(async ({ cwd, commonDir, initial }) => {
    initial.stacks[0].branches = initial.stacks[0].branches.slice(0, 1);
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "remove", branch: "bottom", mode: "forget" } }));
    const fault = vi.spyOn(GhStackCatalogStore.prototype, "removeJournal").mockRejectedValueOnce(new Error("interrupted before journal unlink"));
    try {
      expect((await bus.dispatch("stack:apply", { ...request, planId: plan.id })).ok).toBe(false);
    } finally {
      fault.mockRestore();
    }
    expect(value(await bus.dispatch("stack:list", request))).toMatchObject({ recoveryAvailable: true, stacks: [] });
    value(await bus.dispatch("stack:recover", request));
    expect(value(await bus.dispatch("stack:list", request))).not.toHaveProperty("busy");
  })
);

test.skipIf(!existsSync(native))("stack Git limits simultaneous conflict probes and keeps its local-only environment with a profile", () =>
  withStack(async ({ cwd, commonDir, initial }) => {
    await commit(cwd, "bottom.txt", "upstream conflict");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    let active = 0;
    let peak = 0;
    const localOnly: string[] = [];
    const observed: GitExec = async (args, directory, opts) => {
      active++;
      peak = Math.max(peak, active);
      if (args.includes("replay") || args.includes("rebase")) localOnly.push(opts?.env?.GIT_NO_LAZY_FETCH ?? "missing");
      try { return await execute(args, directory, opts); }
      finally { active--; }
    };
    const profile = { email: "profile@example.invalid", authorName: "Review Fixture" } as Profile;
    const { bus, request, stackId } = await setup(cwd, commonDir, observed, profile);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      expect(localOnly.length).toBeGreaterThanOrEqual(2);
      expect(new Set(localOnly)).toEqual(new Set(["1"]));
      const states = await Promise.all(Array.from({ length: 8 }, () => bus.dispatch("stack:conflict", { ...request, stackId })));
      expect(states.map(value).every(state => state?.phase === "resolving")).toBe(true);
      expect(peak).toBeLessThanOrEqual(4);
    } finally {
      await git(pause.worktreePath, "rebase", "--abort");
      value(await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id }));
    }
  })
);

test.skipIf(!existsSync(native))("finishing a root detach selects the affected stack independently of catalog order", () =>
  withStack(async ({ cwd, commonDir, initial, base }) => {
    await commit(cwd, "top.txt", "upstream conflicts with former child");
    await git(cwd, "branch", "other", base);
    initial.stacks.push({ trunk: { branch: "main", head: base }, branches: [{ branch: "other", base, head: base }] });
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "remove", mode: "detach", branch: "bottom" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      await writeFile(join(pause.worktreePath, "top.txt"), "resolved former child");
      await git(pause.worktreePath, "add", "top.txt");
      await git(pause.worktreePath, "-c", "core.editor=true", "rebase", "--continue");
      const finished = value(await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id }));
      expect(finished.applied?.stack?.layers.map(layer => layer.branch)).toEqual(["top"]);
      expect(await git(cwd, "show", "top:top.txt")).toBe("resolved former child");
    } finally {
      if (existsSync(pause.worktreePath)) await git(cwd, "worktree", "remove", pause.worktreePath);
    }
  })
);

test.skipIf(!existsSync(native))("a second conflict uses a fresh checkout and preserves the first resolution", () =>
  withStack(async ({ cwd, commonDir, initial }) => {
    await commit(cwd, "bottom.txt", "upstream conflict");
    await commit(cwd, "top.txt", "second upstream conflict");
    await writeFile(join(commonDir, "gh-stack"), JSON.stringify(initial));
    const { bus, request, stackId } = await setup(cwd, commonDir);
    const plan = value(await bus.dispatch("stack:plan", { ...request, stackId, action: { kind: "restack" } }));
    const pause = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    const resolveFile = async (path: string, file: string) => {
      await writeFile(join(path, file), `resolved ${file}`);
      await git(path, "add", file);
      await git(path, "-c", "core.editor=true", "rebase", "--continue");
    };
    await resolveFile(pause.worktreePath, "bottom.txt");
    const continuation = value(await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id }));
    expect(continuation.plan?.steps.at(-1)).toMatchObject({ branch: "top", conflict: { files: ["top.txt"] } });
    expect(existsSync(pause.worktreePath)).toBe(false);
    const second = value(await bus.dispatch("stack:resolve", { ...request, planId: plan.id }));
    try {
      expect(second.worktreePath).not.toBe(pause.worktreePath);
      await resolveFile(second.worktreePath, "top.txt");
      value(await bus.dispatch("stack:finishConflict", { ...request, planId: plan.id }));
      expect(await git(cwd, "show", "top:bottom.txt")).toBe("resolved bottom.txt");
      expect(await git(cwd, "show", "top:top.txt")).toBe("resolved top.txt");
    } finally {
      if (existsSync(second.worktreePath)) await git(cwd, "worktree", "remove", second.worktreePath);
    }
  })
);
