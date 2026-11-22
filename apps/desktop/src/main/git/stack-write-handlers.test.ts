import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Repo, Result } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { NativeStackLocks } from "./stack-catalog-store";
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

async function setup(cwd: string, common: string) {
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
    git: execute, queue: new WorktreeOperationQueue(), reader,
    findRepo: find, findProfile: () => null, changed: async () => undefined,
  });
  const snapshot = value(await bus.dispatch("stack:list", request));
  return { bus, request, stackId: snapshot.stacks[0].id, catalog: join(common, "gh-stack") };
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
