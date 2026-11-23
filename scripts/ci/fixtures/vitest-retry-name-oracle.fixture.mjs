import { beforeEach, describe, expect, it } from "vitest";
import { markRetryableTestBody } from "../vitest-test-body.ts";

const phase = process.env.PWRGIT_RETRY_NAME_ORACLE_PHASE;
const timeout = 250;

beforeEach(({ task }) => {
  if (phase === "hook") throw new Error("hook failed");
  if (phase === "hook-timeout" && task.name === "timeout batch 2") return new Promise(() => {});
}, timeout);

const firstRun = phase === "first";

it("top-level (case)", () => {
  if (phase === "infra") throw Object.assign(new Error("listen EPERM"), { code: "EPERM" });
  expect(firstRun).toBe(false);
});

it.for([1, 2, 3])("timeout batch %i", (batch, { task }) => {
  markRetryableTestBody(task);
  if (phase === "timeout" && batch === 2) return new Promise(() => {});
}, timeout);

const withFixture = it.extend({
  value: async ({ signal }, use) => {
    if (phase === "fixture-timeout") await new Promise(() => {});
    if (phase === "fixture-released-on-abort") {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    await use("ready");
  },
});

withFixture("uses a fixture", ({ task, value }) => {
  markRetryableTestBody(task);
  expect(value).toBe("ready");
  if (phase === "fixture-body-timeout") return new Promise(() => {});
}, timeout);

describe("suite [one]", () => {
  it("nested + case", () => expect(firstRun).toBe(false));
  describe("deeper (two)", () => {
    it("nested .* case", () => expect(firstRun).toBe(false));
    it("passing case must not be retried", () => expect(phase).not.toBe("retry"));
  });
});
