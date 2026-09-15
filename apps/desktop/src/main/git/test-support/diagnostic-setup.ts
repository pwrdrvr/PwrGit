import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { configureGitDiagnostics, gitDiagnosticContext, type GitDiagnosticReport } from "../git-diagnostics";
import { GitDiagnosticJournal } from "./diagnostic-journal";
import { startOwnership, type OwnershipSession } from "./pipe-ownership.cjs";

const thresholdMs = 5000;
let testId: string | undefined;
let suite: string | undefined;
let file: string | undefined;
let artifactFailed = false;
let journal: GitDiagnosticJournal | undefined;
let ownership: OwnershipSession | undefined;

const targetedSuite = () => suite === "remote.test.ts" || suite === "rebase-assistant.test.ts";
const settings = () => ({ thresholdMs, emit, ...(journal ? { record: journal.record } : {}),
  ...(targetedSuite() ? { commandThresholdsMs: { fetch: 2000, clone: 2000 }, retainCommands: ["fetch", "clone"] } : {}) });

function emit(report: GitDiagnosticReport): void {
  const line = JSON.stringify({ schema: 2, workerPid: process.pid, suite, testId, ...report });
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

beforeAll(async () => {
  const path = expect.getState().testPath?.replaceAll("\\", "/") ?? "";
  // Local temp repositories and controlled subprocess fixtures, not network
  // clones or all of production. No configuration is installed in the app.
  if (!path.includes("/src/main/git/")) return;
  suite = basename(path);
  const directory = process.env.PWRGIT_GIT_DIAGNOSTICS_DIR ?? join(process.cwd(), "test-results", "git-diagnostics");
  try {
    mkdirSync(directory, { recursive: true });
    file = join(directory, `git-${process.pid}-${process.env.VITEST_WORKER_ID ?? "0"}.jsonl`);
    journal = new GitDiagnosticJournal(directory, suite, emit);
    // The historically implicated suites use synchronous fixture Git. Await
    // readiness here so their first blocking call is independently observable.
    if (targetedSuite() || suite === "partial-staging.test.ts") {
      await journal.startWatchdog(thresholdMs);
    }
    journal.begin("suite-setup");
    if (targetedSuite() && process.env.PWRGIT_GIT_PIPE_OWNERSHIP === "1") {
      ownership = await startOwnership(directory);
      ownership.context = { suite, testId: "suite-setup" };
    }
  } catch { process.stderr.write("[git-diagnostic] artifact directory unavailable\n"); }
  configureGitDiagnostics(settings());
});

beforeEach((context) => {
  if (!suite) return;
  journal?.end(gitDiagnosticContext());
  testId = context.task.id;
  if (ownership) ownership.context = { suite, testId,
    targetBranchTest: context.task.name === "keeps a local merge commit that range-diff omits" };
  journal?.begin(testId);
  configureGitDiagnostics(settings());
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
    const finalContext = { ...gitDiagnosticContext(), elapsedMs, state: context.task.result?.state };
    // Keep the test ID attached while disposal persists any final timelines.
    configureGitDiagnostics(undefined);
    journal?.end(finalContext);
    testId = undefined;
    // A nested describe's beforeAll can run between test scopes. Its Trace2
    // calls must not inherit the ID of the preceding completed test.
    if (ownership) ownership.context = { suite, testId: "between-tests" };
  });
});

afterAll(async () => {
  if (suite) {
    journal?.end(gitDiagnosticContext());
    configureGitDiagnostics(undefined);
    await journal?.close();
    await ownership?.close();
  }
});
