import { describe, expect, it } from "vitest";
import {
  parseBranchRefs,
  parseChanges,
  parseLog,
  parseWorktreeList
} from "./git-service";

describe("parseBranchRefs", () => {
  const row = (fields: string[]): string => fields.join("\t");

  it("marks the current branch, classifies remotes, and reads upstream", () => {
    const out = parseBranchRefs(
      [
        row([
          "refs/heads/main",
          "main",
          "*",
          "origin/main",
          "2026-07-01T00:00:00-04:00",
          "latest on main"
        ]),
        row([
          "refs/heads/feat/x",
          "feat/x",
          " ",
          "",
          "2026-06-01T00:00:00-04:00",
          "wip"
        ]),
        row([
          "refs/remotes/origin/release",
          "origin/release",
          " ",
          "",
          "2026-05-01T00:00:00-04:00",
          "cut release"
        ])
      ].join("\n")
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      name: "main",
      isRemote: false,
      isCurrent: true,
      upstream: "origin/main"
    });
    expect(out[1]).toMatchObject({ name: "feat/x", isCurrent: false });
    expect(out[1].upstream).toBeUndefined();
    expect(out[2]).toMatchObject({ name: "origin/release", isRemote: true });
  });

  it("skips a remote's symbolic HEAD pointer", () => {
    const out = parseBranchRefs(
      [
        row(["refs/remotes/origin/HEAD", "origin/HEAD", " ", "", "", ""]),
        row([
          "refs/remotes/origin/main",
          "origin/main",
          " ",
          "",
          "2026-05-01T00:00:00-04:00",
          "tip"
        ])
      ].join("\n")
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("origin/main");
  });
});

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

describe("parseChanges", () => {
  it("splits staged vs unstaged and handles rename + untracked", () => {
    const stdout = [
      "1 M. N... 100644 100644 100644 aaa bbb staged-only.txt",
      "1 .M N... 100644 100644 100644 ccc ddd unstaged.txt",
      "1 MM N... 100644 100644 100644 eee fff both.txt",
      "2 R. N... 100644 100644 100644 ggg hhh R100 new.txt\told.txt",
      "? untracked.txt"
    ].join("\n");

    const cs = parseChanges(stdout);
    expect(cs.staged.map((f) => f.path)).toEqual([
      "staged-only.txt",
      "both.txt",
      "new.txt"
    ]);
    expect(cs.unstaged.map((f) => f.path)).toEqual([
      "unstaged.txt",
      "both.txt",
      "untracked.txt"
    ]);
    expect(cs.staged.find((f) => f.path === "new.txt")?.status).toBe("R");
    expect(cs.unstaged.find((f) => f.path === "untracked.txt")?.status).toBe(
      "?"
    );
  });
});
