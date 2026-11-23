import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { GhStackCatalogStore, NativeStackLocks } from "./stack-catalog-store";
import { StackEngine } from "./stack-engine";
import { commit, git, gitEnvironment, runner, withStack } from "./stack-engine/fixture.test-support";

const native = fileURLToPath(new URL(`../../../build/mcp/pwrgit-mcp${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const nativeMissing = !existsSync(native);
const ghStackV030 = (() => {
  try { return execFileSync("gh", ["stack", "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("version 0.3.0"); }
  catch { return false; }
})();
const locks = new NativeStackLocks(() => native);
const store = new GhStackCatalogStore(locks);

describe.skipIf(nativeMissing)("gh stack catalog interoperability (requires pnpm build:native)", () => {
  test("CAS preserves a concurrent writer including unrelated stack fields", () => withStack(async ({ commonDir, initial }) => {
    const empty = await store.read(commonDir);
    await store.writeIfUnchanged(commonDir, initial, empty.sha256);
    const first = await store.read(commonDir);
    const other = structuredClone(first.catalog);
    other.stacks[0].number = 7;
    await store.writeIfUnchanged(commonDir, other, first.sha256);
    await expect(store.writeIfUnchanged(commonDir, empty.catalog, first.sha256)).rejects.toThrow("catalog changed");
    expect((await store.read(commonDir)).catalog).toEqual(other);
  }));

  test.each(["operation", "catalog"] as const)("%s lock probes and times out only while held", kind => withStack(async ({ commonDir }) => {
    await locks.withLock(commonDir, kind, async () => {
      expect(await locks.busy(commonDir)).toBe(true);
      const start = performance.now();
      await expect(locks.withLock(commonDir, kind, async () => undefined)).rejects.toThrow("gh stack is running");
      expect(performance.now() - start).toBeGreaterThanOrEqual(4_900);
    });
    expect(await locks.busy(commonDir)).toBe(false);
    expect(existsSync(join(commonDir, kind === "operation" ? "gh-stack-operation.lock" : "gh-stack.lock"))).toBe(true);
  }));

  test("each foreign journal blocks all mutation entry points and leaves bytes intact", () => withStack(async ({ cwd, commonDir, initial }) => {
    await store.writeIfUnchanged(commonDir, initial, "");
    const engine = new StackEngine(runner, store, cwd, commonDir);
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    const before = await readFile(join(commonDir, "gh-stack"));
    for (const file of ["gh-stack-rebase-state", "gh-stack-modify-state", "gh-stack-migration", "pwragent-stack-op.json"]) {
      await writeFile(join(commonDir, file), "{}");
      await expect(engine.apply(plan, "blocked", 1)).rejects.toThrow(/gh stack is|PwrAgent has/);
      await expect(engine.undo("blocked")).rejects.toThrow(/gh stack is|PwrAgent has/);
      expect(await readFile(join(commonDir, "gh-stack"))).toEqual(before);
      await unlink(join(commonDir, file));
    }
  }));

  test("a newer catalog stays readable and its bytes are immutable", () => withStack(async ({ cwd, commonDir, initial }) => {
    const data = JSON.stringify({ schemaVersion: 8, anotherFormat: true });
    await writeFile(join(commonDir, "gh-stack"), data);
    const snapshot = await store.read(commonDir);
    expect(snapshot.catalog.schemaVersion).toBe(8);
    await expect(new StackEngine(runner, store, cwd, commonDir).plan({ kind: "restack", root: "bottom" })).rejects.toThrow("read-only");
    await expect(store.writeIfUnchanged(commonDir, initial, snapshot.sha256)).rejects.toThrow("read-only");
    expect(await readFile(join(commonDir, "gh-stack"), "utf8")).toBe(data);
  }));

  test.skipIf(!ghStackV030)("round trips through gh stack view --json (requires gh stack v0.3.0)", () => withStack(async ({ cwd, commonDir, initial }) => {
    await store.writeIfUnchanged(commonDir, initial, "");
    const engine = new StackEngine(runner, store, cwd, commonDir);
    await commit(cwd, "advance.txt", "trunk update\n");
    await git(cwd, "switch", "-q", "top");
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    await engine.apply(plan, "interop", 1, store.journalHooks(commonDir));
    expect(await store.journalBlocker(commonDir)).toBeUndefined();
    const expected = (await store.read(commonDir)).catalog.stacks[0];
    const output = execFileSync("gh", ["stack", "view", "--json"], { cwd, encoding: "utf8", env: {
      ...gitEnvironment, GH_CONFIG_DIR: join(cwd, ".no-gh-auth"), GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    } });
    const parsed = JSON.parse(output);
    expect(parsed.trunk).toBe(expected.trunk.branch);
    expect(parsed.branches.map(({ name, head, base }: { name: string; head: string; base: string }) =>
      ({ branch: name, head, base }))).toEqual(expected.branches);
    expect((await store.read(commonDir)).catalog.stacks[0]).toEqual(expected);
  }));
});
