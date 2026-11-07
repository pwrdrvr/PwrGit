import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  if (process.env.PWRGIT_RETRY_NAME_ORACLE_PHASE === "hook") throw new Error("hook failed");
});

const firstRun = process.env.PWRGIT_RETRY_NAME_ORACLE_PHASE === "first";

it("top-level (case)", () => {
  if (process.env.PWRGIT_RETRY_NAME_ORACLE_PHASE === "infra") throw Object.assign(new Error("listen EPERM"), { code: "EPERM" });
  expect(firstRun).toBe(false);
});
describe("suite [one]", () => {
  it("nested + case", () => expect(firstRun).toBe(false));
  describe("deeper (two)", () => {
    it("nested .* case", () => expect(firstRun).toBe(false));
    it("passing case must not be retried", () => expect(firstRun).toBe(true));
  });
});
