import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planE2eRetry, verifyE2eRetry } from "./retry-failures.mjs";

describe("Playwright retry identity oracle", () => {
  it("selects the same test for an assertion or command exit and refuses unsafe runs", () => {
    const desktop = path.resolve("apps/desktop");
    const cache = path.join(desktop, "node_modules/.cache");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(path.join(cache, "ci-retry-oracle-"));
    const config = path.join(directory, "playwright.config.cjs");
    const reporter = path.resolve("scripts/ci/playwright-ci-reporter.mjs");
    const sandbox = path.resolve("apps/desktop/e2e/fixtures/git-sandbox.ts");
    const cli = path.join(desktop, "node_modules/@playwright/test/cli.js");
    const last = path.join(directory, "last.json");
    writeFileSync(config, `module.exports = { testDir: ${JSON.stringify(directory)}, workers: 1, retries: 0, reporter: [[${JSON.stringify(reporter)}]] };\n`);
    writeFileSync(path.join(directory, "example.spec.cjs"), `
      const { test: base, expect } = require('@playwright/test');
      const { join } = require('node:path');
      const { createGitSandbox } = require(${JSON.stringify(sandbox)});
      const phase = process.env.RETRY_ORACLE_PHASE;
      function failGitCommand(runInMissingDirectory = false) {
        const box = createGitSandbox();
        try {
          const cwd = runInMissingDirectory ? join(box.reposDir, 'missing') : box.reposDir;
          box.git(cwd, 'worktree', 'list');
        }
        finally { box.cleanup(); }
      }
      const test = base.extend({ checkCommand: [async ({}, use) => {
        if (phase === 'fixture') failGitCommand();
        await use();
      }, { auto: true }] });
      test.beforeEach(() => { if (phase === 'hook') failGitCommand(); });
      test('failed case', () => {
        if (phase === 'command') failGitCommand();
        if (phase === 'spawn-error') failGitCommand(true);
        if (phase === 'worker-exit') process.exit(23);
        expect(phase).not.toBe('first');
      });
      test('passing case', () => expect(['first', 'command', 'spawn-error', 'worker-exit']).toContain(phase));
      test.skip('intentional skip', () => {});
    `);
    const run = (phase, args = []) => {
      const report = path.join(directory, `${phase}.json`);
      const result = spawnSync(process.execPath, [cli, "test", "-c", config, ...args], {
        cwd: desktop, encoding: "utf8",
        env: { ...process.env, RETRY_ORACLE_PHASE: phase, PWRGIT_CI_TEST_REPORT: report, PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: last },
      });
      return { result, report: JSON.parse(readFileSync(report, "utf8")), last: JSON.parse(readFileSync(last, "utf8")) };
    };
    try {
      const first = run("first");
      expect(first.result.status).toBe(1);
      const plan = planE2eRetry(first.report, first.last, 20);
      expect(plan.tests).toHaveLength(1);
      const command = run("command");
      expect(command.result.status).toBe(1);
      expect(planE2eRetry(command.report, command.last, 20)).toEqual(plan);
      const retry = run("retry", ["--last-failed"]);
      expect(retry.result.status, retry.result.stderr).toBe(0);
      expect(verifyE2eRetry(plan, retry.report)).toBe(true);
      const incomplete = run("first", ["--max-failures=1"]);
      expect(incomplete.report.complete).toBe(false);
      expect(() => planE2eRetry(incomplete.report, incomplete.last, 20)).toThrow();
      for (const phase of ["spawn-error", "worker-exit"]) {
        const unsafe = run(phase);
        expect(unsafe.report.tests.some((test) => test.unsafeFailure), phase).toBe(true);
        expect(() => planE2eRetry(unsafe.report, unsafe.last, 20), phase).toThrow();
      }
      for (const phase of ["hook", "fixture"]) {
        const outsideBody = run(phase);
        expect(outsideBody.report.hookErrors, phase).toBeGreaterThan(0);
        expect(() => planE2eRetry(outsideBody.report, outsideBody.last, 20), phase).toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
