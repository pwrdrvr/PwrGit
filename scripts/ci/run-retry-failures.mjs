import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isCliEntrypoint } from "../lib/cli-entrypoint.mjs";
import { planE2eRetry, planUnitRetry, verifyE2eRetry, verifyInitialE2eRun, verifyInitialUnitRun, verifyUnitRetry } from "./retry-failures.mjs";

const directory = path.resolve(".local/ci/retry");
const read = (name) => JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};
const budget = 20;
console.log(`Per-slice retry budget: ${budget} initially failed tests`);

function retryUnits() {
  const first = read("unit-first.json");
  const plan = planUnitRetry(first, budget);
  summary(`### Unit retry: ${plan.tests.length} initially failed test(s), budget ${budget}`);
  for (const test of plan.tests) {
    summary(`- ${test.project}: ${test.file} — ${test.name}`);
  }
  const modules = new Map();
  for (const test of plan.tests) {
    const key = JSON.stringify([test.project, test.file]);
    if (!modules.has(key)) modules.set(key, { project: test.project, file: test.file, tests: [] });
    modules.get(key).tests.push(test);
  }
  const selection = path.join(directory, "unit-selection.json");
  const report = path.join(directory, "unit-retry-0.json");
  writeFileSync(selection, JSON.stringify([...modules.values()]));
  rmSync(report, { force: true });
  const result = spawnSync(process.execPath, ["scripts/ci/vitest-retry-runner.mjs", selection], {
    stdio: "inherit", env: { ...process.env, PWRGIT_CI_TEST_REPORT: report },
  });
  let passed = false;
  try {
    passed = result.status === 0 && verifyUnitRetry(plan, JSON.parse(readFileSync(report, "utf8")));
  } catch {
    // A missing report or crashed process cannot clear the original failure.
  }
  summary(passed ? "All selected unit tests passed on retry." : "Unit retry failed or did not run the selected tests.");
  if (!passed) process.exitCode = 1;
}

function prepareE2e() {
  const plan = planE2eRetry(read("e2e-first.json"), read("e2e-last.json"), budget);
  summary(`### E2E retry: ${plan.tests.length} initially failed test(s), budget ${budget}`);
  for (const test of plan.tests) summary(`- ${test.name}`);
  // Playwright clears these locations at startup. Preserve the first attempt.
  for (const name of ["test-results", "playwright-report"]) {
    const source = path.resolve("apps/desktop", name);
    if (existsSync(source)) cpSync(source, path.join(directory, `first-${name}`), { recursive: true });
  }
}

function verifyE2e() {
  const plan = planE2eRetry(read("e2e-first.json"), read("e2e-first-last.json"), budget);
  const passed = process.env.PWRGIT_RETRY_OUTCOME === "success" && verifyE2eRetry(plan, read("e2e-retry.json"));
  summary(passed ? "All selected E2E tests passed on retry." : "E2E retry failed or did not run the selected tests.");
  if (!passed) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) try {
  mkdirSync(directory, { recursive: true });
  switch (process.argv[2]) {
    case "unit": retryUnits(); break;
    case "unit-verify": {
      const report = read("unit-first.json");
      if (!verifyInitialUnitRun(report)) throw new Error("The unit slice did not complete successfully");
      const tests = report.suites.flatMap((suite) => suite.tests);
      const passed = tests.filter((test) => test.state === "passed").length;
      summary(`Unit slice completed: ${tests.length} discovered, ${passed} passed, ${tests.length - passed} skipped.`);
      break;
    }
    case "e2e-first-verify": {
      const report = read("e2e-first.json");
      if (!verifyInitialE2eRun(report)) throw new Error("The E2E slice did not complete successfully");
      const expected = report.tests.filter((test) => test.outcome === "expected").length;
      summary(`E2E slice completed: ${report.tests.length} discovered, ${expected} expected outcomes, ${report.tests.length - expected} skipped.`);
      break;
    }
    case "e2e-prepare":
      prepareE2e();
      cpSync(path.join(directory, "e2e-last.json"), path.join(directory, "e2e-first-last.json"));
      break;
    case "e2e-verify": verifyE2e(); break;
    default: throw new Error("Unknown CI test verification command");
  }
} catch (error) {
  summary(`Retry unavailable: ${error.message}`);
  process.exitCode = 1;
}
