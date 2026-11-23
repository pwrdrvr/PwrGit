import { beforeEach, describe, expect, it } from "vitest";

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

it.each([1, 2, 3])("timeout batch %i", (batch) => {
  if (phase === "timeout" && batch === 2) return new Promise(() => {});
}, timeout);
describe("suite [one]", () => {
  it("nested + case", () => expect(firstRun).toBe(false));
  describe("deeper (two)", () => {
    it("nested .* case", () => expect(firstRun).toBe(false));
    it("passing case must not be retried", () => expect(phase).not.toBe("retry"));
  });
});
