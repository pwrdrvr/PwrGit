import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GIB, cappedNodeOptions, getToolResourcePolicy, readCgroupMemoryLimits, resourceCommand, resourceEnvironment } from "./tool-resource-policy.mjs";

const low = { constrained: true };
const high = { constrained: false };

describe("machine capacity", () => {
  it.each([
    [16 * GIB - 1, true], [16 * GIB, false], [16 * GIB + 1, false],
    [8 * GIB, true], [32 * GIB, false],
  ])("uses the strict threshold at %d bytes", (hostMemory, constrained) => {
    expect(getToolResourcePolicy({ env: {}, hostMemory, constrainedMemory: 0, cgroupLimits: [] })).toEqual({ hostMemory, effectiveMemory: hostMemory, constrained });
  });

  it("uses total host capacity and the smallest finite OS/ancestor limit", () => {
    const policy = (host, os, groups) => getToolResourcePolicy({ env: {}, hostMemory: host * GIB, constrainedMemory: os * GIB, cgroupLimits: groups.map((n) => n * GIB) });
    expect(policy(32, 24, [20, 8, 12]).effectiveMemory).toBe(8 * GIB);
    expect(policy(8, 24, [20, 32]).effectiveMemory).toBe(8 * GIB);
    expect(policy(32, 0, [Infinity, NaN, -1]).constrained).toBe(false);
    expect(policy(32, 0, [0]).effectiveMemory).toBe(0);
  });

  it.each([{ CI: "true" }, { CI: "1" }, { CI: "TRUE" }, { CI: " yes " }, { GITHUB_ACTIONS: "true", CI: "false" }])("preserves CI command and environment semantics despite a small container (%j)", (env) => {
    const policy = getToolResourcePolicy({ env, hostMemory: 32 * GIB, constrainedMemory: 8 * GIB, cgroupLimits: [4 * GIB] });
    expect(policy).toEqual({ hostMemory: 32 * GIB, effectiveMemory: 4 * GIB, constrained: false });
    const inherited = { ...env, NODE_OPTIONS: "--max-old-space-size=6144 --trace-warnings" };
    for (const [command, args] of [
      ["node", ["--max-old-space-size=6144", "-e", "console.log(1)"]],
      ["pnpm", ["-r", "--parallel", "--workspace-concurrency=8", "typecheck"]],
      ["vitest", ["run", "--maxWorkers=4", "--fileParallelism=true"]],
      ["playwright", ["test", "--workers=4"]],
    ]) {
      expect(resourceEnvironment(command, args, inherited, policy)).toBe(inherited);
      expect(resourceCommand(command, args, policy)).toBe(args);
    }
  });

  it.each([{}, { CI: "false" }, { CI: " FALSE " }, { CI: "0" }, { CI: "" }, { CI: "  " }])("keeps developer restrictions when CI is absent or disabled (%j)", (env) => {
    expect(getToolResourcePolicy({ env, hostMemory: 8 * GIB, constrainedMemory: 0, cgroupLimits: [] }).constrained).toBe(true);
  });

  it.each([
    ["0::/parent/child", "cgroup2 cgroup rw", "memory.max"],
    ["3:cpu,memory:/parent/child", "cgroup cgroup rw,cpu,memory", "memory.limit_in_bytes"],
  ])("reads finite ancestors when the leaf is unlimited (%s)", (member, mount, limitFile) => {
    const files = {
      "/proc/self/cgroup": member,
      "/proc/self/mountinfo": `1 0 0:1 / /sys/fs/cgroup rw - ${mount}`,
      [`/sys/fs/cgroup/parent/child/${limitFile}`]: "max",
      [`/sys/fs/cgroup/parent/${limitFile}`]: String(12 * GIB),
      [`/sys/fs/cgroup/${limitFile}`]: String(8 * GIB),
    };
    expect(readCgroupMemoryLimits((file) => files[file] ?? "", "linux")).toEqual([12 * GIB, 8 * GIB]);
  });

  it("handles mount roots, namespaces, escaped paths, and unreadable mounts", () => {
    const files = {
      "/proc/self/cgroup": "0::/pod/child",
      "/proc/self/mountinfo": "1 0 0:1 /pod /cgroup\\040mount rw - cgroup2 cgroup rw",
      "/cgroup mount/child/memory.max": "max",
      "/cgroup mount/memory.max": String(4 * GIB),
    };
    expect(readCgroupMemoryLimits((file) => files[file] ?? "", "linux")).toEqual([4 * GIB]);
    files["/proc/self/cgroup"] = "0::/";
    expect(readCgroupMemoryLimits((file) => files[file] ?? "", "linux")).toEqual([4 * GIB]);
    expect(readCgroupMemoryLimits(() => { throw new Error("unreadable"); }, "linux")).toEqual([]);
    expect(readCgroupMemoryLimits(() => { throw new Error("must not read"); }, "darwin")).toEqual([]);
  });
});

describe("constrained command policy", () => {
  it.each([
    "--max-old-space-size=6144", "--max_old_space_size 6144", '"--max-old-space-size=6144"',
    "--max-old-space-size-percentage=90 --max-old-space-size=6144",
    "--max_old_space_size_percentage 90 --max_old_space_size 6144",
  ])("replaces inherited overrides (%s)", (options) => {
    expect(cappedNodeOptions(options)).toBe("--max-old-space-size=2048");
    expect(cappedNodeOptions(options, 4096)).toBe("--max-old-space-size=4096");
  });

  it("retains unrelated quoted preloads, warnings, and diagnostic options", () => {
    expect(cappedNodeOptions('--require "/path with spaces/init.cjs" --trace-warnings --max-old-space-size=6144 --diagnostic-dir="a b"'))
      .toBe('--require "/path with spaces/init.cjs" --trace-warnings --diagnostic-dir="a b" --max-old-space-size=2048');
  });

  it("rewrites CLI Node overrides without changing script arguments", () => {
    expect(resourceCommand("node", ["--max-old-space-size=6144", "--max_old_space_size_percentage", "90", "-r", "a b.cjs", "script.js", "--max-old-space-size=777"], low))
      .toEqual(["--max-old-space-size=2048", "-r", "a b.cjs", "script.js", "--max-old-space-size=777"]);
    expect(resourceCommand("node", ["--max-old-space-size=6144", "-e", "console.log(1)"], low))
      .toEqual(["--max-old-space-size=2048", "-e", "console.log(1)"]);
    expect(resourceCommand("node", ["--title", "probe", "--max-old-space-size=6144", "script.js"], low))
      .toEqual(["--max-old-space-size=2048", "--title", "probe", "script.js"]);
    expect(resourceCommand("NODE.EXE", ["--max-old-space-size=6144", "-e", "console.log(1)"], low))
      .toEqual(["--max-old-space-size=2048", "-e", "console.log(1)"]);
  });

  it.each(["-e", "--eval", "-p", "--print", "-pe"])("removes startup overrides after a %s expression while preserving operands", (evalFlag) => {
    const expression = "'--max-old-space-size=6144'";
    expect(resourceCommand("node", ["--title", "--max-old-space-size=6144", evalFlag, expression, "--max_old_space_size", "6144", "--max-old-space-size-percentage=90", "--", "--max-old-space-size=777"], low))
      .toEqual(["--max-old-space-size=2048", "--title", "--max-old-space-size=6144", evalFlag, expression, "--", "--max-old-space-size=777"]);
    expect(cappedNodeOptions("--title --max-old-space-size=6144 --max-old-space-size=6144"))
      .toBe("--title --max-old-space-size=6144 --max-old-space-size=2048");
  });

  it("preserves equals-form expressions and stops at the first application positional argument", () => {
    expect(resourceCommand("node", ["--eval=console.log(1)", "--max-old-space-size=6144", "application-arg", "--max-old-space-size=777"], low))
      .toEqual(["--max-old-space-size=2048", "--eval=console.log(1)", "application-arg", "--max-old-space-size=777"]);
  });

  it("replaces both pair and equals pnpm concurrency and parallel overrides", () => {
    expect(resourceCommand("pnpm", ["-r", "--workspace-concurrency", "8", "--parallel", "--workspace-concurrency=12", "typecheck"], low))
      .toEqual(["--workspace-concurrency=1", "-r", "typecheck"]);
    expect(resourceCommand("pnpm", ["--filter", "@pwrgit/desktop", "build"], low)).toEqual(["--filter", "@pwrgit/desktop", "build"]);
    expect(resourceCommand("pnpm", ["--node-options", "--trace-warnings --max-old-space-size-percentage=90", "-r", "typecheck"], low))
      .toEqual(["--workspace-concurrency=1", "-r", "typecheck"]);
    const env = { NODE_OPTIONS: "--max-old-space-size=6144" };
    expect(resourceEnvironment("pnpm", ["--node-options", "--trace-warnings --max-old-space-size-percentage=90"], env, low).NODE_OPTIONS)
      .toBe("--trace-warnings --max-old-space-size=2048");
    expect(resourceEnvironment("pnpm", ["--node-options=--max-old-space-size=6144"], env, high)).toBe(env);
  });

  it("enforces one Vitest worker while retaining native test isolation", async () => {
    const args = resourceCommand("vitest", ["run", "--maxWorkers", "8", "--min-workers=3", "--maxConcurrency=9", "--fileParallelism=true"], low);
    expect(args).toEqual(["run", "--maxWorkers=1", "--no-file-parallelism", "--maxConcurrency=1"]);
    const config = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
    expect(config).not.toMatch(/isolate\s*:\s*false|pool\s*:\s*["']threads["']/);
    expect(resourceCommand("playwright", ["test", "--workers", "4"], low)).toEqual(["test", "--workers=1"]);
  });

  it.each(["pnpm", "node", "vitest", "playwright"])("keeps every argv unchanged on larger machines (%s)", (command) => {
    const args = ["-r", "--workspace-concurrency", "8", "--max-old-space-size=6144", "--maxWorkers=8"];
    expect(resourceCommand(command, args, high)).toBe(args);
  });
});
