import { describe, expect, it } from "vitest";
import { parseWorktreeList } from "./git-service";

describe("parseWorktreeList", () => {
  it("parses primary + linked worktrees and strips refs/heads/", () => {
    const out = parseWorktreeList(
      [
        "worktree /repo/main",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo/wt/feature",
        "HEAD def456",
        "branch refs/heads/feat/x",
        ""
      ].join("\n")
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: "/repo/main", branch: "main" });
    expect(out[1]).toMatchObject({
      path: "/repo/wt/feature",
      branch: "feat/x"
    });
  });

  it("labels detached and bare worktrees", () => {
    const out = parseWorktreeList(
      [
        "worktree /repo/bare",
        "bare",
        "",
        "worktree /repo/det",
        "HEAD 0123456789abcdef",
        "detached",
        ""
      ].join("\n")
    );
    expect(out[0]).toMatchObject({ bare: true, branch: "(bare)" });
    expect(out[1]).toMatchObject({ detached: true, branch: "detached@0123456" });
  });
});
