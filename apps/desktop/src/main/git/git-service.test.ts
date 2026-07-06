import { describe, expect, it } from "vitest";
import { parseLog, parseWorktreeList } from "./git-service";

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

describe("parseLog", () => {
  it("parses delimited records into commits and flags merges", () => {
    const record = (fields: string[]): string => fields.join("\x1f") + "\x1e";
    const stdout =
      record(["h1", "p0 p1", "Nick", "n@x.com", "2026-01-02T00:00:00Z", "merge x"]) +
      record(["h2abcdef0", "", "Nick", "n@x.com", "2026-01-01T00:00:00Z", "init"]);

    const commits = parseLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: "h1",
      parents: ["p0", "p1"],
      isMerge: true,
      authorEmail: "n@x.com",
      subject: "merge x"
    });
    expect(commits[1]).toMatchObject({
      hash: "h2abcdef0",
      shortHash: "h2abcde",
      parents: [],
      isMerge: false
    });
  });
});
