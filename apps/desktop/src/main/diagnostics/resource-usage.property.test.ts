import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { GitResourceUsage, ProcessResourceUsage, gitResourceCommand, gitResourceUsage, withResourceSource } from "./resource-usage";
import { execGit, execGitBinary, execGitRecords } from "../git/dugite";
import { tmpdir } from "node:os";
import { limitConcurrency } from "../util/map-limit";

describe("resource accounting", () => {
  // Model invariant: every spawn and completion is counted exactly once,
  // including children spanning arbitrarily many sample boundaries. Draining
  // counters must never erase live children or change their original label.
  it("conserves starts, completions, live children and lifetimes across samples", () => {
    fc.assert(fc.property(fc.array(fc.record({
      action: fc.constantFrom("start", "finish", "sample"),
      choice: fc.nat(100),
      failed: fc.boolean(),
      advance: fc.nat(1000)
    }), { maxLength: 100 }), (actions) => {
      const usage = new GitResourceUsage();
      const live: Array<{ at: number; finish: ReturnType<GitResourceUsage["start"]> }> = [];
      let at = 0;
      let starts = 0;
      let completed = 0;
      let nonzero = 0;
      let wallMs = 0;
      let seenStarts = 0;
      let seenCompleted = 0;
      let seenNonzero = 0;
      let seenWall = 0;
      let expectedPeak = 0;
      const sample = (): void => {
        const got = usage.sample();
        expect(got.active).toBe(live.length);
        expect(got.peak).toBe(expectedPeak);
        expect(got.buckets.reduce((sum, b) => sum + b.active, 0)).toBe(live.length);
        for (const b of got.buckets) {
          seenStarts += b.started;
          seenCompleted += b.completed;
          seenNonzero += b.nonzero;
          seenWall += b.wallMs;
        }
        expect([seenStarts, seenCompleted, seenNonzero, seenWall]).toEqual([starts, completed, nonzero, wallMs]);
        expectedPeak = live.length;
      };
      for (const action of actions) {
        at += action.advance;
        if (action.action === "start") {
          starts++;
          live.push({ at, finish: usage.start(["status"], "bulk-pull", at) });
          expectedPeak = Math.max(expectedPeak, live.length);
        } else if (action.action === "finish" && live.length > 0) {
          const child = live.splice(action.choice % live.length, 1)[0]!;
          child.finish(action.failed, at);
          child.finish(action.failed, at); // repeated lifecycle notifications are harmless
          completed++;
          nonzero += Number(action.failed);
          wallMs += at - child.at;
        } else if (action.action === "sample") sample();
      }
      sample();
      sample();
    }));
  });

  it("keeps every label independent of user-supplied paths, refs and credentials", () => {
    fc.assert(fc.property(fc.string(), fc.constantFrom("status", "fetch", "log"), (secret, command) => {
      expect(gitResourceCommand(["-c", `credential.helper=${secret}`, "-C", secret, command, secret])).toBe(command);
      expect(gitResourceCommand([`unknown:${secret}`, "status"])).toBe("other");
    }));
  });

  it("uses cumulative CPU counters despite repeated samples, resets and PID reuse", () => {
    fc.assert(fc.property(fc.array(fc.record({
      pid: fc.integer({ min: 1, max: 4 }), born: fc.nat(4), cpu: fc.nat(1000)
    }), { minLength: 1, maxLength: 50 }), (steps) => {
      const usage = new ProcessResourceUsage();
      let previous: typeof steps[number] | undefined;
      for (const step of steps) {
        const [got] = usage.sample([{ pid: step.pid, creationTime: step.born, type: "Tab", cpu: { cumulativeCPUUsage: step.cpu } }]);
        const expected = previous === undefined ? null :
          previous.pid === step.pid && previous.born === step.born ? Math.max(0, step.cpu - previous.cpu) : step.cpu;
        expect(got?.cpuSeconds).toBe(expected);
        previous = step;
      }
    }));
    expect(new ProcessResourceUsage().sample([{ pid: 1, creationTime: 0, type: "Tab", cpu: {} }])[0]?.cpuSeconds).toBeNull();
  });

  // Differential oracle: all production adapters must count the actual child,
  // once, with the initiating async context even behind a shared queue.
  it("observes every production Git adapter and preserves overlapping job origins", async () => {
    const observed = vi.spyOn(gitResourceUsage, "start");
    try {
      const run = limitConcurrency(async (adapter: number) => {
        if (adapter === 0) return execGit(["rev-parse", "--git-dir"], tmpdir());
        if (adapter === 1) return execGitBinary(["rev-parse", "--git-dir"], tmpdir());
        return execGitRecords(["rev-parse", "--git-dir"], tmpdir(), { matches: () => true, maxChars: 1024, maxRecords: 10 });
      }, 1);
      const origins = ["bulk-pull", "visible-refresh", "authored-sweep"] as const;
      await Promise.all(origins.map((origin, i) => withResourceSource(origin, () => run(i))));
      expect(observed.mock.calls.map((call) => call[1])).toEqual(origins);
      expect(observed.mock.calls.map((call) => gitResourceCommand(call[0]))).toEqual(["rev-parse", "rev-parse", "rev-parse"]);
    } finally {
      observed.mockRestore();
    }
  });
});
