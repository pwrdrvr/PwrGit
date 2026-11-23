import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planUnitRetry, verifyUnitRetry } from "./retry-failures.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const config = path.join(root, "scripts/ci/fixtures/vitest-retry-name-oracle.config.mjs");
const reporter = path.join(root, "scripts/ci/vitest-ci-reporter.mjs");

function run(directory, phase) {
  const reportPath = path.join(directory, `${phase}.json`);
  const result = spawnSync(process.execPath, [vitest, "run", "--config", config, "--reporter", reporter], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PWRGIT_CI_TEST_REPORT: reportPath,
      PWRGIT_RETRY_NAME_ORACLE_PHASE: phase,
    },
  });
  return { result, report: JSON.parse(readFileSync(reportPath, "utf8")) };
}

function expectVerifiedRetry(directory, selected) {
  const selection = path.join(directory, "selection.json");
  const retryPath = path.join(directory, "retry.json");
  rmSync(retryPath, { force: true });
  writeFileSync(selection, JSON.stringify([{ project: selected[0].project, file: selected[0].file, tests: selected }]));
  const result = spawnSync(process.execPath, [path.join(root, "scripts/ci/vitest-retry-runner.mjs"), selection, config], {
    cwd: root, encoding: "utf8", env: { ...process.env, PWRGIT_CI_TEST_REPORT: retryPath, PWRGIT_RETRY_NAME_ORACLE_PHASE: "retry" },
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const retry = JSON.parse(readFileSync(retryPath, "utf8"));
  expect(verifyUnitRetry({ tests: selected }, retry)).toBe(true);
}

describe("Vitest retry oracle", () => {
  it("selects exactly the initial IDs at every nesting depth", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-retry-name-oracle-"));
    try {
      const first = run(directory, "first");
      expect(first.result.status).toBe(1);
      const hook = run(directory, "hook");
      expect(hook.result.status).toBe(1);
      expect(hook.report.hookErrors).toBeGreaterThan(0);
      expect(() => planUnitRetry(hook.report, 20)).toThrow();
      const infra = run(directory, "infra");
      expect(infra.report.suites.flatMap((suite) => suite.tests).some((test) => test.unsafeFailure)).toBe(true);
      expect(() => planUnitRetry(infra.report, 20)).toThrow();
      const plan = planUnitRetry(first.report, 20);
      expect(plan.tests).toHaveLength(3);
      for (const selected of [...plan.tests.map((test) => [test]), plan.tests]) {
        expectVerifiedRetry(directory, selected);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("retries only the parameterized case whose test body timed out and refuses a hook timeout", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwrgit-retry-timeout-oracle-"));
    try {
      const hook = run(directory, "hook-timeout");
      expect(hook.result.status).toBe(1);
      expect(() => planUnitRetry(hook.report, 20)).toThrow();

      const first = run(directory, "timeout");
      expect(first.result.status).toBe(1);
      expect(first.report.complete).toBe(true);
      const plan = planUnitRetry(first.report, 20);
      expect(plan.tests.map((test) => test.name)).toEqual(["timeout batch 2"]);
      expectVerifiedRetry(directory, plan.tests);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
