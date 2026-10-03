import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

// Evaluate the boolean subset used by these actual job conditions. GitHub adds
// success() when no status function is present, so a skipped audit ancestor must
// be represented in the fixture rather than treating prepare's success as enough.
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions
// Actionlint separately validates the complete workflow syntax.
function eligible(job, { github, needs, cancelled = false, ancestors }) {
  const body = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  const expression = body?.match(/^    if: (?:>-\s*\n\s*)?\$\{\{([\s\S]*?)\}\}/m)?.[1];
  if (!expression) throw new Error(`Missing job condition for ${job}`);
  const success = () => ancestors.every((result) => result === "success");
  if (!/\b(?:success|failure|always|cancelled)\s*\(/.test(expression) && !success()) return false;
  const js = expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]')
    .replace("github.event.pull_request.labels.*.name", "github.event.pull_request.labels.map(label => label.name)");
  return runInNewContext(js, { github, needs, cancelled: () => cancelled, success,
    contains: (items, value) => items.includes(value) });
}

function context({ event = "pull_request", action = "labeled", fork = false, label = "ci:windows-signing", audit = "skipped", prepare = "success", cancelled = false } = {}) {
  return {
    github: { repository: "pwrdrvr/PwrGit", event_name: event, event: {
      action, label: { name: label }, pull_request: {
        head: { repo: { full_name: fork ? "contributor/PwrGit" : "pwrdrvr/PwrGit" } }, labels: [{ name: label }],
      },
    } },
    needs: { "distribution-audit": { result: audit }, "windows-prepare": { result: prepare } },
    ancestors: [audit, prepare], cancelled,
  };
}

test.each(["labeled", "synchronize", "reopened"])("signed PR smoke remains eligible after its audit is skipped (%s)", (action) => {
  const fixture = context({ action });
  expect(eligible("windows-prepare", fixture)).toBe(true);
  expect(eligible("windows-sign", fixture)).toBe(true);
});

test.each(["failure", "skipped", "cancelled"])("does not sign when preparation ends with %s", (prepare) => {
  expect(eligible("windows-sign", context({ prepare }))).toBe(false);
});

test.each([{ fork: true }, { label: "unrelated" }, { cancelled: true }])("does not prepare/sign an ineligible PR %#", (options) => {
  const fixture = context(options);
  expect(eligible("windows-prepare", fixture)).toBe(false);
  expect(eligible("windows-sign", { ...fixture, needs: { ...fixture.needs, "windows-prepare": { result: "skipped" } } })).toBe(false);
});

test.each(["push", "workflow_dispatch"])("prepares and signs an audited release (%s)", (event) => {
  const fixture = context({ event, audit: "success" });
  expect(eligible("windows-prepare", fixture)).toBe(true);
  expect(eligible("windows-sign", fixture)).toBe(true);
});

test("failed preflight and cancellation do not enter signing", () => {
  const fixture = context({ event: "push", audit: "failure", prepare: "skipped" });
  expect(eligible("windows-prepare", fixture)).toBe(false);
  expect(eligible("windows-sign", fixture)).toBe(false);
  expect(eligible("windows-sign", context({ cancelled: true }))).toBe(false);
});
