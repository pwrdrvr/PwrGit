import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sameTestIds, unsafeFailure } from "./retry-failures.mjs";

export default class CiRetryReporter {
  errors = 0;
  hookErrors = 0;

  onStepEnd(_test, _result, step) {
    if ((step.category === "hook" || step.category === "fixture") && step.error) this.hookErrors++;
  }

  onBegin(_config, suite) {
    this.suite = suite;
    this.selectedIds = suite.allTests().map((test) => test.id);
  }

  onError() {
    this.errors++;
  }

  onEnd(result) {
    const destination = process.env.PWRGIT_CI_TEST_REPORT;
    if (!destination) throw new Error("PWRGIT_CI_TEST_REPORT is required");
    mkdirSync(path.dirname(destination), { recursive: true });
    const tests = this.suite?.allTests().map((test) => ({
      id: test.id,
      name: test.titlePath().filter(Boolean).join(" > "),
      outcome: test.outcome(),
      expectedStatus: test.expectedStatus,
      status: test.results.length === 1 ? test.results[0].status : null,
      unsafeFailure: test.outcome() === "unexpected"
        ? unsafeFailure(test.results.flatMap((attempt) => attempt.errors ?? [])) : false,
      completed: test.results.length === 1
        && test.results.every((attempt) => attempt.status !== "interrupted")
        && (test.outcome() !== "skipped" || test.expectedStatus === "skipped"),
    })) ?? [];
    writeFileSync(destination, JSON.stringify({
      status: result.status,
      complete: result.status !== "interrupted" && tests.length > 0
        && sameTestIds(this.selectedIds, tests.map((test) => test.id))
        && tests.every((test) => test.completed),
      errors: this.errors,
      hookErrors: this.hookErrors,
      tests,
    }));
  }
}
