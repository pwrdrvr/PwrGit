import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isUnitRunComplete, unsafeFailure } from "./retry-failures.mjs";

function matchName(test) {
  const parts = [test.name];
  for (let parent = test.parent; parent && parent.type !== "module"; parent = parent.parent) parts.unshift(parent.name);
  return parts.join(" ");
}

// Keep this report separate from the JSON timings report and from console logs.
export default class CiRetryReporter {
  planned = [];
  finished = [];
  collected = [];
  startedTests = new Set();
  finishedTests = new Set();
  activeHooks = new Map();

  onInit(context) {
    this.context = context;
  }

  async onTestRunStart(specifications) {
    // Vitest announces the full workspace here, then applies the configured
    // sequencer's shard inside the pool. Use that same selection so the
    // completeness check covers this lane rather than every lane.
    const selected = this.context.config.shard
      ? await new this.context.config.sequence.sequencer(this.context).shard([...specifications])
      : specifications;
    this.planned = selected.map((specification) => JSON.stringify([specification.project.name, specification.moduleId]));
  }

  onTestModuleEnd(module) {
    this.finished.push(JSON.stringify([module.project.name, module.moduleId]));
  }

  onTestModuleCollected(module) {
    this.collected.push({
      key: JSON.stringify([module.project.name, module.moduleId]),
      ids: [...module.children.allTests()].map((test) => test.id),
    });
  }

  onHookStart(hook) {
    const key = JSON.stringify([hook.entity.id, hook.name]);
    this.activeHooks.set(key, (this.activeHooks.get(key) ?? 0) + 1);
  }

  onHookEnd(hook) {
    const key = JSON.stringify([hook.entity.id, hook.name]);
    this.activeHooks.set(key, (this.activeHooks.get(key) ?? 0) - 1);
  }

  onTestCaseReady(test) {
    this.startedTests.add(test.id);
  }

  onTestCaseResult(test) {
    this.finishedTests.add(test.id);
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const destination = process.env.PWRGIT_CI_TEST_REPORT;
    if (!destination) throw new Error("PWRGIT_CI_TEST_REPORT is required");
    const suites = modules.map((module) => ({
      project: module.project.name,
      file: module.moduleId,
      key: JSON.stringify([module.project.name, module.moduleId]),
      errors: module.errors().length
        + [...module.children.allSuites()].reduce((sum, suite) => sum + suite.errors().length, 0),
      tests: [...module.children.allTests()].map((test) => ({
        id: test.id,
        name: test.fullName,
        matchName: matchName(test),
        state: test.result().state,
        unsafeFailure: test.result().state === "failed" ? unsafeFailure(test.result().errors) : false,
        mode: test.options.mode,
        started: this.startedTests.has(test.id),
        completed: this.finishedTests.has(test.id),
      })),
    }));
    mkdirSync(path.dirname(destination), { recursive: true });
    const completedModules = new Set(this.finished);
    writeFileSync(destination, JSON.stringify({
      complete: isUnitRunComplete({ reason, planned: this.planned, finished: this.finished, modules: suites, collected: this.collected }),
      reason,
      completion: {
        plannedModules: this.planned.length,
        finishedModules: this.finished.length,
        collectedTests: this.collected.reduce((sum, item) => sum + item.ids.length, 0),
        reportedTests: suites.reduce((sum, suite) => sum + suite.tests.length, 0),
        unfinishedModules: this.planned.filter((key) => !completedModules.has(key)).map((key) => JSON.parse(key)),
      },
      unhandledErrors: unhandledErrors.length,
      hookErrors: [...this.activeHooks.values()].reduce((sum, count) => sum + Math.abs(count), 0),
      suites,
    }));
  }
}
