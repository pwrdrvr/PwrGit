import { describe, expect, it } from "vitest";
import {
  branchNameProblem,
  initialCheckoutTarget,
  suggestBranchName
} from "./branch-from-commit";

describe("suggestBranchName", () => {
  it("strips a conventional-commit prefix and the trailing PR number", () => {
    expect(
      suggestBranchName("fix(desktop): reconcile native sub-agent accounting (#1727)")
    ).toBe("reconcile-native-sub-agent-accounting");
  });

  it("keeps a plain subject, punctuation collapsed", () => {
    expect(suggestBranchName("Align pane header dividers!")).toBe(
      "align-pane-header-dividers"
    );
  });

  it("handles a breaking-change marker", () => {
    expect(suggestBranchName("feat!: drop the legacy index")).toBe(
      "drop-the-legacy-index"
    );
  });

  it("caps the length without leaving a trailing separator", () => {
    const long = suggestBranchName(
      "chore: rename every single one of the extremely verbose configuration keys"
    );
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
  });

  it("gives back nothing when the subject has no usable characters", () => {
    expect(suggestBranchName("!!! ???")).toBe("");
  });
});

describe("branchNameProblem", () => {
  it("accepts an ordinary namespaced name", () => {
    expect(branchNameProblem("fix/accounting", ["main"])).toBeNull();
  });

  it("reports an empty or whitespace-only name", () => {
    expect(branchNameProblem("   ", [])).toEqual({ kind: "empty" });
  });

  it("reports a name that already exists", () => {
    expect(branchNameProblem("main", ["main", "dev"])).toEqual({ kind: "taken" });
  });

  it("compares the trimmed name against existing branches", () => {
    expect(branchNameProblem("  main  ", ["main"])).toEqual({ kind: "taken" });
  });

  it.each([
    ["has a space", "my branch"],
    ["has a tilde", "fix~1"],
    ["has a caret", "fix^"],
    ["has a colon", "fix:thing"],
    ["has a backslash", "fix\\thing"],
    ["has two dots", "fix..thing"],
    ["has a reflog suffix", "fix@{1}"],
    ["ends with a slash", "fix/"],
    ["contains an empty segment", "fix//thing"],
    ["starts with a dot", ".fix"],
    ["ends with .lock", "fix.lock"]
  ])("rejects a name that %s", (_case, name) => {
    expect(branchNameProblem(name, [])?.kind).toBe("malformed");
  });
});

describe("initialCheckoutTarget", () => {
  it("restores the remembered choice", () => {
    expect(initialCheckoutTarget("new-worktree", true)).toBe("new-worktree");
    expect(initialCheckoutTarget("here", true)).toBe("here");
  });

  it("falls back when an in-place checkout is unavailable", () => {
    expect(initialCheckoutTarget("here", false)).toBe("new-worktree");
  });

  it("leaves the other choices alone in a dirty worktree", () => {
    expect(initialCheckoutTarget("none", false)).toBe("none");
    expect(initialCheckoutTarget("new-worktree", false)).toBe("new-worktree");
  });
});
