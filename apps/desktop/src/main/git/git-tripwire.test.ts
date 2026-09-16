import { tmpdir } from "node:os";
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

it("does not let a failed diagnostic sink replace the result", () => {
  scope = new GitTripwire(() => { throw new Error("sink unavailable"); });
  expect(timedGitSync(["status"], tmpdir(), () => "result")).toBe("result");
});
