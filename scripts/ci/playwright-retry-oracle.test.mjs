import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planE2eRetry, verifyE2eRetry } from "./retry-failures.mjs";

describe("Playwright retry identity oracle", () => {
  it("selects only the failed IDs and refuses incomplete or hook-failed runs", () => {
    const desktop = path.resolve("apps/desktop");
    const cache = path.join(desktop, "node_modules/.cache");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(path.join(cache, "ci-retry-oracle-"));
    const config = path.join(directory, "playwright.config.cjs");
    const reporter = path.resolve("scripts/ci/playwright-ci-reporter.mjs");
    const cli = path.join(desktop, "node_modules/@playwright/test/cli.js");
    const last = path.join(directory, "last.json");
    writeFileSync(config, `module.exports = { testDir: ${JSON.stringify(directory)}, workers: 1, retries: 0, reporter: [[${JSON.stringify(reporter)}]] };\n`);
    writeFileSync(path.join(directory, "example.spec.cjs"), `
      const { test, expect } = require('@playwright/test');
      test.beforeEach(() => { if (process.env.RETRY_ORACLE_PHASE === 'hook') throw new Error('hook'); });
      test('failed case', () => { if (process.env.RETRY_ORACLE_PHASE === 'infra') throw new Error('listen EPERM'); expect(process.env.RETRY_ORACLE_PHASE).not.toBe('first'); });
      test('passing case', () => expect(process.env.RETRY_ORACLE_PHASE).toBe('first'));
      test.skip('intentional skip', () => {});
    `);
    const run = (phase, args = []) => {
      const report = path.join(directory, `${phase}.json`);
      const result = spawnSync(process.execPath, [cli, "test", "-c", config, ...args], {
        cwd: desktop, encoding: "utf8",
        env: { ...process.env, RETRY_ORACLE_PHASE: phase, PWRGIT_CI_TEST_REPORT: report, PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: last },
      });
      return { result, report: JSON.parse(readFileSync(report, "utf8")) };
    };
    try {
      const first = run("first");
      expect(first.result.status).toBe(1);
      const plan = planE2eRetry(first.report, JSON.parse(readFileSync(last, "utf8")), 20);
      expect(plan.tests).toHaveLength(1);
      const retry = run("retry", ["--last-failed"]);
      expect(retry.result.status, retry.result.stderr).toBe(0);
      expect(verifyE2eRetry(plan, retry.report)).toBe(true);
      const incomplete = run("first", ["--max-failures=1"]);
      expect(incomplete.report.complete).toBe(false);
      const infra = run("infra");
      expect(infra.report.tests.some((test) => test.unsafeFailure)).toBe(true);
      expect(() => planE2eRetry(infra.report, JSON.parse(readFileSync(last, "utf8")), 20)).toThrow();
      const hook = run("hook");
      expect(hook.report.hookErrors).toBeGreaterThan(0);
      expect(() => planE2eRetry(hook.report, JSON.parse(readFileSync(last, "utf8")), 20)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
