// A runner can attach OS and process failures to an individual test rather
// than emitting a global error. Do not use those failures as retry candidates.
export function unsafeFailure(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return true;
  const infrastructure = /\b(?:EACCES|EPERM|ENOSPC|EMFILE|ENFILE|ENOMEM|EIO|EADDRINUSE|EADDRNOTAVAIL|ECONNREFUSED|ECONNRESET|EPIPE|ENOENT|ETIMEDOUT)\b|(?:browser|worker|process) (?:has )?(?:crashed|exited unexpectedly|closed unexpectedly)/i;
  return errors.some((error) => {
    if (!error) return true;
    const message = String(error.message ?? error.value ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const isAssertion = error.name === "AssertionError" || /^Error:\s*expect\(/.test(message);
    return !isAssertion || infrastructure.test(`${error.code ?? ""} ${message}`);
  });
}

export function sameTestIds(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
  const ids = new Set(expected);
  return ids.size === expected.length && actual.every((id) => typeof id === "string" && id.length > 0 && ids.delete(id))
    && ids.size === 0;
}

export function isUnitRunComplete({ reason, planned, finished, modules, collected }) {
  if ((reason !== "passed" && reason !== "failed") || !Array.isArray(planned) || !planned.length
    || !Array.isArray(finished) || !Array.isArray(modules) || !Array.isArray(collected)) return false;
  const expected = new Set(planned);
  if (expected.size !== planned.length || finished.length !== expected.size || modules.length !== expected.size
    || new Set(finished).size !== expected.size || finished.some((key) => !expected.has(key))) return false;
  const selectedTests = new Map();
  for (const item of collected) {
    if (!expected.has(item.key) || selectedTests.has(item.key)) return false;
    selectedTests.set(item.key, item.ids);
  }
  if (selectedTests.size !== expected.size) return false;
  const found = new Set();
  for (const module of modules) {
    if (!expected.has(module.key) || found.has(module.key) || !Array.isArray(module.tests)) return false;
    found.add(module.key);
    if (!sameTestIds(selectedTests.get(module.key), module.tests.map((test) => test.id))) return false;
    for (const test of module.tests) {
      if (!test.completed || !["passed", "failed", "skipped"].includes(test.state)
        || (test.state === "skipped" && test.mode === "run" && !test.started)) return false;
    }
  }
  return true;
}

export function unitRetryNamePattern(tests) {
  return `^(?:${tests.map((test) => (test.matchName ?? test.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
}

export function planUnitRetry(report, budget) {
  if (report?.reason !== "failed" || !report.complete || report.unhandledErrors !== 0 || report.hookErrors !== 0 || !Array.isArray(report.suites)) {
    throw new Error("The first run did not finish cleanly enough to select retries");
  }
  const tests = [];
  const ids = new Set();
  for (const suite of report.suites) {
    if (suite.errors || typeof suite.project !== "string" || !suite.file || !Array.isArray(suite.tests)) {
      throw new Error("A suite failed outside an individual test");
    }
    for (const test of suite.tests) {
      if (!["passed", "failed", "skipped"].includes(test.state)) {
        throw new Error("The first run left an unfinished test");
      }
      if (test.state !== "failed") continue;
      if (test.unsafeFailure !== false) throw new Error("A test reported an infrastructure or unclassified failure");
      if (!test.id || !test.name || ids.has(test.id)) throw new Error("Ambiguous test identity");
      if (suite.tests.filter((candidate) => (candidate.matchName ?? candidate.name) === (test.matchName ?? test.name)).length !== 1) {
        throw new Error(`Cannot select duplicate test name: ${test.name}`);
      }
      ids.add(test.id);
      tests.push({ ...test, project: suite.project, file: suite.file });
    }
  }
  if (!tests.length || tests.length > budget) {
    throw new Error(`Cannot retry ${tests.length} failed tests (budget: ${budget})`);
  }
  return { tests };
}

export function verifyInitialUnitRun(report) {
  return report?.reason === "passed" && report.complete === true && report.unhandledErrors === 0 && report.hookErrors === 0
    && Array.isArray(report.suites) && report.suites.length > 0
    && report.suites.every((suite) => suite.errors === 0 && Array.isArray(suite.tests)
      && suite.tests.every((test) => test.state === "passed" || test.state === "skipped"))
    && report.suites.some((suite) => suite.tests.some((test) => test.state === "passed"));
}

export function canRetryAfterShutdown(state) {
  return state?.schemaVersion === 1 && state.consecutiveAbnormalCloses === 0 && state.open === false;
}

export function groupUnitRetries(plan, report) {
  const projects = new Map();
  for (const test of plan.tests) {
    projects.set(test.project, [...(projects.get(test.project) ?? []), test]);
  }
  const groups = [];
  for (const [project, tests] of projects) {
    const files = new Set(tests.map((test) => test.file));
    const names = new Set(tests.map((test) => test.matchName ?? test.name));
    const conflict = report.suites.some((suite) => suite.project === project && files.has(suite.file)
      && suite.tests.some((test) => test.state !== "failed" && names.has(test.matchName ?? test.name)));
    if (!conflict) {
      groups.push({ project, files: [...files], tests });
      continue;
    }
    for (const file of files) {
      groups.push({ project, files: [file], tests: tests.filter((test) => test.file === file) });
    }
  }
  return groups;
}

export function planE2eRetry(report, lastRun, budget) {
  if (report?.status !== "failed" || report.complete !== true || report.errors !== 0 || report.hookErrors !== 0 || !Array.isArray(report.tests)
    || lastRun?.status !== "failed" || !Array.isArray(lastRun.failedTests)) {
    throw new Error("The first E2E run did not produce a complete failure report");
  }
  const failed = report.tests.filter((test) => test.outcome === "unexpected");
  const ids = new Set(failed.map((test) => test.id));
  if (failed.some((test) => test.expectedStatus !== "passed" || test.status !== "failed" || test.unsafeFailure !== false)) throw new Error("An E2E test reported an infrastructure or unclassified failure");
  if (!failed.length || failed.length > budget || ids.size !== failed.length
    || !sameTestIds([...ids], lastRun.failedTests)) {
    throw new Error(`Cannot retry ${failed.length} failed E2E tests (budget: ${budget}); selection is incomplete or ambiguous`);
  }
  return { tests: failed };
}

export function verifyInitialE2eRun(report) {
  return report?.status === "passed" && report.complete === true && report.errors === 0 && report.hookErrors === 0
    && Array.isArray(report.tests) && report.tests.length > 0
    && report.tests.every((test) => test.outcome === "expected" || test.outcome === "skipped")
    && report.tests.some((test) => test.outcome === "expected");
}

export function verifyE2eRetry(plan, report) {
  if (report?.status !== "passed" || report.complete !== true || report.errors !== 0 || report.hookErrors !== 0 || !Array.isArray(report.tests)) return false;
  const expected = new Map(plan.tests.map((test) => [test.id, test]));
  return report.tests.length === expected.size
    && report.tests.every((test) => {
      const initial = expected.get(test.id);
      return initial && initial.name === test.name && expected.delete(test.id) && test.outcome === "expected" && test.status === "passed" && test.expectedStatus === "passed";
    })
    && expected.size === 0;
}

export function verifyUnitRetry(plan, report) {
  if (!report?.complete || report.unhandledErrors !== 0 || report.hookErrors !== 0 || !Array.isArray(report.suites)) return false;
  const expected = new Set(plan.tests.map((test) => test.id));
  const initial = new Map(plan.tests.map((test) => [test.id, test]));
  const seen = new Set();
  for (const suite of report.suites) {
    if (suite.errors || !Array.isArray(suite.tests)) return false;
    for (const test of suite.tests) {
      if (test.state === "skipped") continue;
      if (!expected.has(test.id) || test.state !== "passed" || seen.has(test.id)
        || test.name !== initial.get(test.id).name || suite.file !== initial.get(test.id).file
        || suite.project !== initial.get(test.id).project) return false;
      seen.add(test.id);
    }
  }
  return seen.size === expected.size;
}
