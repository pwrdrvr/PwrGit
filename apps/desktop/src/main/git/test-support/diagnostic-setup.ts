import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { configureGitDiagnostics, gitDiagnosticContext, type GitDiagnosticReport } from "../git-diagnostics";

const thresholdMs = 5000;
let testId: string | undefined;
let suite: string | undefined;
let file: string | undefined;
let artifactFailed = false;

function emit(report: GitDiagnosticReport): void {
  const line = JSON.stringify({ schema: 1, workerPid: process.pid, suite, testId, ...report });
  // Each report is written immediately, not deferred to afterEach (which may
  // never run). A worker has its own file; no cross-worker append contention.
  if (file) {
    try { appendFileSync(file, `${line}\n`); }
    catch {
      if (!artifactFailed) process.stderr.write("[git-diagnostic] artifact write failed; reports remain in stderr\n");
      artifactFailed = true;
    }
  }
  process.stderr.write(`[git-diagnostic] ${line}\n`);
}

beforeAll(() => {
  const path = expect.getState().testPath?.replaceAll("\\", "/") ?? "";
  // Local temp repositories and controlled subprocess fixtures, not network
  // clones or all of production. No configuration is installed in the app.
  if (!path.includes("/src/main/git/")) return;
  suite = basename(path);
  const directory = process.env.PWRGIT_GIT_DIAGNOSTICS_DIR;
  if (directory) {
    try {
      mkdirSync(directory, { recursive: true });
      file = join(directory, `git-${process.pid}-${process.env.VITEST_WORKER_ID ?? "0"}.jsonl`);
    } catch { process.stderr.write("[git-diagnostic] artifact directory unavailable\n"); }
  }
  configureGitDiagnostics({ thresholdMs, emit });
});

beforeEach((context) => {
  if (!suite) return;
  testId = context.task.id;
  configureGitDiagnostics({ thresholdMs, emit });
  const started = performance.now();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    emit({ event: "slow-test", elapsedMs: performance.now() - started,
      timerLatenessMs: Math.max(0, performance.now() - started - thresholdMs),
      ...gitDiagnosticContext() });
  }, thresholdMs);
  timer.unref();
  context.onTestFinished(() => {
    clearTimeout(timer);
    const elapsedMs = performance.now() - started;
    if (fired || elapsedMs >= thresholdMs || context.task.result?.state === "fail") {
      emit({ event: "test-finished", elapsedMs, timerFired: fired,
        state: context.task.result?.state, ...gitDiagnosticContext() });
    }
    configureGitDiagnostics(undefined);
    testId = undefined;
  });
});

afterAll(() => { if (suite) configureGitDiagnostics(undefined); });
