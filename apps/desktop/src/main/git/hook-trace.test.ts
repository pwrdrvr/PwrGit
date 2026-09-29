import { describe, expect, it } from "vitest";
import { parseHookTrace } from "./hook-trace";

describe("parseHookTrace", () => {
  it("pairs real trace2 hook events by session and child ID", () => {
    const line = (value: object) => JSON.stringify(value);
    const trace = [
      line({ event: "child_start", sid: "outer", child_id: 0, child_class: "hook", hook_name: "pre-commit", argv: [".husky/_/pre-commit"] }),
      line({ event: "child_start", sid: "nested", child_id: 0, child_class: "shell", argv: ["git"] }),
      line({ event: "child_exit", sid: "nested", child_id: 0, code: 0, t_rel: 0.001 }),
      line({ event: "child_exit", sid: "outer", child_id: 0, code: 1, t_rel: 2.3456 }),
      "not json",
      line({ event: "child_start", sid: "outer", child_id: 1, child_class: "hook", hook_name: "commit-msg", argv: [".husky/_/commit-msg"] }),
      line({ event: "child_exit", sid: "outer", child_id: 1, code: 0, t_rel: 0.12 })
    ].join("\n");
    expect(parseHookTrace(trace)).toEqual([
      { name: "pre-commit", path: ".husky/_/pre-commit", exitCode: 1, elapsedMs: 2346 },
      { name: "commit-msg", path: ".husky/_/commit-msg", exitCode: 0, elapsedMs: 120 }
    ]);
  });

  it("uses Git's hook child class and invoked path when hook_name is absent", () => {
    const trace = [
      JSON.stringify({ event: "child_start", sid: "outer", child_id: 0, child_class: "hook", argv: [".git/hooks/pre-commit"] }),
      JSON.stringify({ event: "child_start", sid: "outer", child_id: 1, child_class: "shell", argv: [".git/hooks/not-a-hook"] }),
      JSON.stringify({ event: "child_exit", sid: "outer", child_id: 1, code: 0, t_rel: 0.01 }),
      JSON.stringify({ event: "child_exit", sid: "outer", child_id: 0, code: 1, t_rel: 0.125 })
    ].join("\n");
    expect(parseHookTrace(trace)).toEqual([
      { name: "pre-commit", path: ".git/hooks/pre-commit", exitCode: 1, elapsedMs: 125 }
    ]);
  });
});
