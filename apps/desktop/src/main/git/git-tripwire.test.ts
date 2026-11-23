import { tmpdir } from "node:os";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { beginGitCall, GitTripwire, timedGitSync } from "./test-support/git-tripwire";
import { createSystemGit } from "./test-support/system-git";

let scope: GitTripwire | undefined;
afterEach(() => { scope?.finish(); scope = undefined; vi.useRealTimers(); });

it("preserves real Git output and records exit/end before helper settlement", async () => {
  const rows: Record<string, any>[] = [];
  scope = new GitTripwire(row => rows.push(row));
  const result = await createSystemGit()(["--version"], tmpdir());
  expect(result.ok && result.value.stdout).toMatch(/^git version /);
  const end = rows.find(row => row.event === "end")!;
  expect(end).toMatchObject({ outcome: "resolved", exitObserved: true, exitCode: 0,
    stdout: { ended: true }, stderr: { ended: true } });
  expect(end.stdoutBytes).toBeGreaterThan(0);
  expect(end.timeline.map((row: { event: string }) => row.event)).toEqual(expect.arrayContaining([
    "spawn", "exit", "stdout-end", "stderr-end", "settlement"
  ]));
});

it("reports pending state without completing a call and cancels timers at scope end", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const rows: Record<string, any>[] = [];
  scope = new GitTripwire(row => rows.push(row), 100);
  let exited = false;
  const call = beginGitCall(["fetch", "credential-value"], "/private-repository", "async",
    () => ({ exitObserved: exited, stdout: { ended: false } }))!;
  vi.advanceTimersByTime(100);
  expect(rows.find(row => row.event === "slow-call")).toMatchObject({ exitObserved: false, timerLatenessMs: 0 });
  expect(rows.some(row => row.event === "end")).toBe(false);
  exited = true;
  call.event("exit");
  call.report("drain-grace-expired");
  expect(rows.at(-1)).toMatchObject({ exitObserved: true, stdout: { ended: false } });
  scope.finish(); scope = undefined;
  const count = rows.length;
  vi.advanceTimersByTime(1000);
  call.report("too-late");
  expect(rows).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
  expect(JSON.stringify(rows)).not.toMatch(/credential-value|private-repository/);
});

it("persists sync begin before blocking, preserves exceptions, and totals many short calls", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const rows: Record<string, any>[] = [];
  scope = new GitTripwire(row => rows.push(row), 100);
  const failure = new Error("private failure");
  expect(() => timedGitSync(["clone"], tmpdir(), () => {
    expect(rows.at(-1)).toMatchObject({ event: "begin", execution: "sync" });
    throw failure;
  })).toThrow(failure);
  for (let i = 0; i < 20; i++) {
    expect(timedGitSync(["status"], tmpdir(), () => { vi.advanceTimersByTime(10); return 42; })).toBe(42);
  }
  scope.finish(); scope = undefined;
  expect(rows.at(-1)).toMatchObject({ event: "test-end", alert: true, completedCalls: 21, totalGitMs: 200, active: [] });
  expect(rows.filter(row => row.event === "end" && row.alert)).toEqual([]);
  expect(JSON.stringify(rows)).not.toContain("private failure");
  expect(vi.getTimerCount()).toBe(0);
});

it("property: every emitted millisecond field is numeric and rounded to three decimal places", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const now = vi.spyOn(performance, "now");
  try {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), ticks => {
      const ms = ticks / 10_000;
      const rows: Record<string, any>[] = [];
      now.mockReturnValue(ms);
      const tripwire = new GitTripwire(row => rows.push(row), 1);
      const finished = tripwire.begin(["config"], tmpdir(), "sync", () => ({}));
      const active = tripwire.begin(["fetch"], tmpdir(), "async", () => ({}));
      try {
        now.mockReturnValue(2 * ms + 1);
        active.event("spawn");
        finished.finish("returned");
        vi.advanceTimersByTime(1);
      } finally {
        tripwire.finish();
      }
      const begin = rows[0]!;
      const call = rows.find(row => row.event === "slow-call")!;
      const summary = rows.at(-1)!;
      const timings = [
        [begin.monotonicMs, ms],
        [call.elapsedMs, ms + 1],
        [call.timerLatenessMs, ms],
        [call.timeline[0].atMs, ms + 1],
        [summary.elapsedMs, ms + 1],
        [summary.totalGitMs, ms + 1],
        [summary.slowest[0].elapsedMs, ms + 1],
        [summary.active[0].elapsedMs, ms + 1],
        [summary.active[0].timeline[0].atMs, ms + 1]
      ];
      for (const [reported, original] of timings) {
        expect(typeof reported).toBe("number");
        expect(reported).toBe(Number(reported.toFixed(3)));
        expect(Math.abs(reported - original)).toBeLessThanOrEqual(0.0005 + 1e-10);
      }
    }));
  } finally {
    now.mockRestore();
  }
});

it("does not let a failed diagnostic sink replace the result", () => {
  scope = new GitTripwire(() => { throw new Error("sink unavailable"); });
  expect(timedGitSync(["status"], tmpdir(), () => "result")).toBe("result");
});
