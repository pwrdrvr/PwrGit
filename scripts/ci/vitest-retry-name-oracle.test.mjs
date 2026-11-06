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

describe("Vitest retry name oracle", () => {
  it("selects exactly the initial IDs at every nesting depth", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-retry-name-oracle-"));
    try {
      const run = (phase, name, pattern) => {
        const reportPath = path.join(directory, `${name}.json`);
        const args = [vitest, "run", "--config", config, "--reporter", reporter];
        if (pattern) args.push("--testNamePattern", pattern);
        const result = spawnSync(process.execPath, args, {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PWRGIT_CI_TEST_REPORT: reportPath,
            PWRGIT_RETRY_NAME_ORACLE_PHASE: phase,
          },
        });
        return { result, report: JSON.parse(readFileSync(reportPath, "utf8")) };
      };

      const first = run("first", "first");
      expect(first.result.status).toBe(1);
      const hook = run("hook", "hook");
      expect(hook.result.status).toBe(1);
      expect(hook.report.hookErrors).toBeGreaterThan(0);
      expect(() => planUnitRetry(hook.report, 20)).toThrow();
      const infra = run("infra", "infra");
      expect(infra.report.suites.flatMap((suite) => suite.tests).some((test) => test.unsafeFailure)).toBe(true);
      expect(() => planUnitRetry(infra.report, 20)).toThrow();
      const plan = planUnitRetry(first.report, 20);
      expect(plan.tests).toHaveLength(3);
      for (const [index, selected] of [...plan.tests.map((test) => [test]), plan.tests].entries()) {
        const selection = path.join(directory, `selection-${index}.json`);
        const retryPath = path.join(directory, `retry-${index}.json`);
        writeFileSync(selection, JSON.stringify([{ project: selected[0].project, file: selected[0].file, tests: selected }]));
        const result = spawnSync(process.execPath, [path.join(root, "scripts/ci/vitest-retry-runner.mjs"), selection, config], {
          cwd: root, encoding: "utf8", env: { ...process.env, PWRGIT_CI_TEST_REPORT: retryPath, PWRGIT_RETRY_NAME_ORACLE_PHASE: "retry" },
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const retry = JSON.parse(readFileSync(retryPath, "utf8"));
        expect(verifyUnitRetry({ tests: selected }, retry)).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
