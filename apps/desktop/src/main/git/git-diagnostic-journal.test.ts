import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configureGitDiagnostics, gitDiagnosticContext, markGitDiagnosticStage, type GitDiagnosticReport } from "./git-diagnostics";
import { GitDiagnosticJournal } from "./test-support/diagnostic-journal";
import { diagnoseSyncGit } from "./test-support/diagnostic-sync";

const directories: string[] = [];
const journals: GitDiagnosticJournal[] = [];
function journalFixture() {
  const base = process.env.PWRGIT_GIT_DIAGNOSTICS_DIR ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "controlled-sync-"));
  directories.push(directory);
  const reports: GitDiagnosticReport[] = [];
  const journal = new GitDiagnosticJournal(directory, "controlled-sync", (report) => reports.push(report));
  journals.push(journal);
  return { journal, reports };
}
function records(file: string): GitDiagnosticReport[] {
  try { return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
  catch { return []; }
}
afterEach(async () => {
  configureGitDiagnostics(undefined);
  for (const journal of journals.splice(0)) await journal.close();
  for (const directory of directories.splice(0)) {
    if (!process.env.PWRGIT_GIT_DIAGNOSTICS_DIR) rmSync(directory, { recursive: true, force: true });
  }
});

describe("synchronous Git diagnostic journal", () => {
  it("persists begin, watchdog and OS evidence while execFileSync blocks the test thread", async () => {
    const { journal, reports } = journalFixture();
    await journal.startWatchdog(100);
    journal.begin("blocking-call");
    configureGitDiagnostics({ thresholdMs: 100, emit: (report) => reports.push(report), record: journal.record });
    markGitDiagnosticStage("operation");
    const quote = (value: string): string => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    const fixture = fileURLToPath(new URL("./test-support/diagnostic-block.cjs", import.meta.url));
    const alias = `!${[process.execPath, fixture, journal.callsFile, journal.watchdogFile].map(quote).join(" ")}`;
    const args = ["-c", `alias.diagnostic-block=${alias}`, "diagnostic-block"];
    let sameThreadTimerFired = false;
    const timer = setTimeout(() => { sameThreadTimerFired = true; }, 20);
    let result: string;
    try {
      result = diagnoseSyncGit(args, tmpdir(), () => execFileSync("git", args, { cwd: tmpdir(), encoding: "utf8" }));
      expect(sameThreadTimerFired).toBe(false);
    } finally { clearTimeout(timer); }
    const child = JSON.parse(result) as { childPid: number; beginId: string };
    const log = records(journal.callsFile);
    const begin = log.find((row) => row.event === "call-begin")!;
    const end = log.find((row) => row.event === "call-end")!;
    const independent = records(journal.watchdogFile);
    const slow = independent.find((row) => row.event === "independent-slow-sync-call")!;
    const sample = independent.find((row) => row.event === "independent-os-process-sample")!;
    expect(child.beginId).toBe(begin.id);
    expect(child.childPid).toBeGreaterThan(0);
    expect(begin).toMatchObject({ execution: "sync", stage: "operation" });
    expect(end).toMatchObject({ id: begin.id, outcome: "resolved" });
    expect(slow).toMatchObject({ observer: "independent-js-thread", call: { id: begin.id, execution: "sync" } });
    expect(Number(slow.observedMonotonicMs)).toBeLessThan(Number(end.monotonicMs));
    expect(Number(sample.observedMonotonicMs)).toBeLessThan(Number(end.monotonicMs));
    if (sample.status === "sampled") {
      // A sample can precede the alias's Node child startup on a slow host.
      // The fixture's worker root is stable; descendants are point-in-time.
      expect(sample.processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: process.pid })]));
    }
    expect(JSON.stringify(log)).not.toContain(alias);
    expect(JSON.stringify(independent)).not.toContain(journal.callsFile);
    journal.end(gitDiagnosticContext());
    await journal.close();
  });

  it("accounts for all 38 completed Git calls when no single call is slow", async () => {
    const { journal, reports } = journalFixture();
    // Short test-level trigger for this controlled check; operation trigger
    // stays at five seconds, so ordinary Git timing semantics are unchanged.
    await journal.startWatchdog(20, false);
    journal.begin("many-calls");
    configureGitDiagnostics({ thresholdMs: 5000, emit: (report) => reports.push(report), record: journal.record });
    for (let i = 0; i < 38; i++) {
      if (i === 0) markGitDiagnosticStage("setup");
      if (i === 19) markGitDiagnosticStage("operation");
      diagnoseSyncGit(["--version"], tmpdir(), () => execFileSync("git", ["--version"], { cwd: tmpdir(), stdio: "ignore" }));
    }
    const context = gitDiagnosticContext();
    journal.end(context);
    await journal.close();
    expect(context).toMatchObject({
      aggregate: { started: 38, completed: 38, rejected: 0 },
      bySource: { "system-git-sync": { completed: 38 } },
      stages: { setup: { completed: 19 }, operation: { completed: 19 } }
    });
    expect(context.recent).toHaveLength(12);
    const aggregate = context.aggregate as { sumMs: number; maxMs: number };
    expect(aggregate.maxMs).toBeLessThan(5000);
    expect(aggregate.sumMs).toBeGreaterThan(20);
    expect(records(journal.callsFile).filter((row) => row.event === "call-begin")).toHaveLength(38);
    expect(records(journal.callsFile).filter((row) => row.event === "call-end")).toHaveLength(38);
    expect(records(journal.watchdogFile).some((row) => row.event === "independent-slow-test")).toBe(true);
    expect(reports.some((row) => ["slow-trigger", "slow-settlement-before-timer", "independent-slow-sync-call"].includes(String(row.event)))).toBe(false);
  });

  it("preserves synchronous exceptions and records a fast scope without later watchdog reports", async () => {
    const { journal, reports } = journalFixture();
    await journal.startWatchdog(200, false);
    journal.begin("fast-throw");
    configureGitDiagnostics({ thresholdMs: 5000, emit: () => {}, record: journal.record });
    const failure = new Error("private-error-message");
    expect(() => diagnoseSyncGit(["status"], "/private-cwd", () => { throw failure; })).toThrow(failure);
    markGitDiagnosticStage("cleanup");
    expect(gitDiagnosticContext()).toMatchObject({ stages: { cleanup: { started: 0, completed: 0 } } });
    journal.end(gitDiagnosticContext());
    await journal.close();
    await new Promise((resolve) => setTimeout(resolve, 220));
    const log = records(journal.callsFile);
    expect(log.find((row) => row.event === "call-end")).toMatchObject({ outcome: "rejected", aggregate: { completed: 1, rejected: 1 } });
    expect(JSON.stringify(log)).not.toContain("private-");
    expect(reports).toEqual([]);
    expect(records(journal.watchdogFile)).toEqual([]);
    expect(gitDiagnosticContext().active).toEqual([]);
  });
});
