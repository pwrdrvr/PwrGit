import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { GitDiagnosticReport } from "../git-diagnostics";

export const diagnosticMonotonicMs = (): number => Number(process.hrtime.bigint()) / 1e6;

/** Test-only journal. Call boundaries are persisted synchronously before the
 * caller can enter execFileSync. A separate JS thread observes those records
 * while the test thread is blocked; it writes its own file, not parent stdio. */
export class GitDiagnosticJournal {
  readonly callsFile: string;
  readonly watchdogFile: string;
  private worker: Worker | undefined;
  private exited = false;
  private closing = false;
  private testId: string | undefined;
  private artifactFailed = false;

  constructor(
    directory: string,
    private readonly suite: string,
    private readonly emit: (report: GitDiagnosticReport) => void
  ) {
    mkdirSync(directory, { recursive: true });
    const suffix = `${process.pid}-${randomUUID()}`;
    this.callsFile = join(directory, `calls-${suffix}.jsonl`);
    this.watchdogFile = join(directory, `watchdog-${suffix}.jsonl`);
  }

  async startWatchdog(thresholdMs: number, processSample = true): Promise<void> {
    try {
      const worker = new Worker(new URL("./diagnostic-watchdog.cjs", import.meta.url), {
        execArgv: [],
        workerData: { file: this.watchdogFile, workerPid: process.pid, thresholdMs, processSample }
      });
      this.worker = worker;
      worker.on("message", (report: GitDiagnosticReport) => {
        if (report.event !== "ready") this.safeEmit(report);
      });
      worker.on("error", () => this.safeEmit({ event: "independent-watchdog-unavailable" }));
      worker.on("exit", () => { this.exited = true; });
      worker.unref();
      await new Promise<void>((resolve) => {
        const ready = (report: GitDiagnosticReport): void => {
          if (report.event === "ready") finish();
        };
        const finish = (): void => {
          clearTimeout(timer);
          worker.removeListener("message", ready);
          worker.removeListener("exit", finish);
          resolve();
        };
        const timer = setTimeout(() => {
          this.safeEmit({ event: "independent-watchdog-startup-delayed" });
          finish();
        }, 3000);
        worker.on("message", ready);
        worker.once("exit", finish);
      });
    } catch { this.safeEmit({ event: "independent-watchdog-unavailable" }); }
  }

  private safeEmit(report: GitDiagnosticReport): void {
    try { this.emit(report); } catch { /* Diagnostic consumers cannot fail tests. */ }
  }

  record = (report: GitDiagnosticReport): void => {
    const row = { schema: 2, workerPid: process.pid, suite: this.suite,
      testId: this.testId, ...report };
    try {
      appendFileSync(this.callsFile, `${JSON.stringify(row)}\n`);
    } catch {
      if (!this.artifactFailed) this.safeEmit({ event: "call-journal-unavailable" });
      this.artifactFailed = true;
    }
    if (!this.closing && !this.exited) {
      try { this.worker?.postMessage(row); } catch { /* Worker already stopped. */ }
    }
  };

  begin(testId: string): void {
    this.testId = testId;
    this.record({ event: "scope-begin", monotonicMs: diagnosticMonotonicMs() });
  }

  end(context: GitDiagnosticReport): void {
    if (this.testId === undefined) return;
    this.record({ event: "scope-end", monotonicMs: diagnosticMonotonicMs(), ...context });
    this.testId = undefined;
  }

  async close(): Promise<void> {
    this.closing = true;
    const worker = this.worker;
    if (!worker || this.exited) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        worker.removeListener("exit", finish);
        resolve();
      };
      // Stop requests cancel only the sampler, never an observed Git process.
      // The fallback bounds cleanup even if the watchdog itself becomes stuck.
      const timer = setTimeout(() => { void worker.terminate().then(finish, finish); }, 2500);
      worker.once("exit", finish);
      worker.postMessage({ event: "stop" });
    });
  }
}
