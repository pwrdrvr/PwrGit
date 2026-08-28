import { describe, expect, it } from "vitest";
import { ok, type Commit } from "@pwrgit/shared";
import {
  parseBranchRefs,
  parseChanges,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseRepoRefRows,
  parseUnappliedUpstreams,
  parseWorktreeList,
  readChanges,
  readCheckoutDirtyCount,
  readCommit,
  topoMergeCommits
} from "./git-service";
import type { GitExec } from "./dugite";

describe("parseNameStatus", () => {
  it("parses modified/added/deleted and takes the NEW path for renames", () => {
    const out = parseNameStatus(
      [
        "M\tsrc/app.ts",
        "A\tdocs/new.md",
        "D\told/file.txt",
        "R100\tsrc/before.ts\tsrc/after.ts",
        ""
      ].join("\n")
    );
    expect(out).toEqual([
      { path: "src/app.ts", status: "M" },
      { path: "docs/new.md", status: "A" },
      { path: "old/file.txt", status: "D" },
      { path: "src/after.ts", status: "R" }
    ]);
  });
});

describe("parseNumstat", () => {
  it("sums text changes and ignores binary placeholders", () => {
    expect(
      parseNumstat(
        [
          "12\t3\tsrc/app.ts",
          "0\t4\tdeleted.txt",
          "-\t-\timages/logo.png",
          ""
        ].join("\n")
      )
    ).toEqual({ additions: 12, deletions: 7 });
  });
});

describe("topoMergeCommits", () => {
  const mk = (hash: string, when: string, ...parents: string[]): Commit => ({
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    subject: hash,
    authorName: "a",
    authorEmail: "a@x.com",
    committedAt: when,
    isMerge: parents.length > 1
  });

  it("keeps children before parents across separately fetched groups", () => {
    const trunk = [
      mk("T2", "2026-07-06T12:00:00Z", "T1"),
      mk("T1", "2026-07-05T12:00:00Z", "B")
    ];
    // Branch segment fetched separately; its parent B is the fork commit,
    // fetched in a third group.
    const branch = [mk("F1", "2026-07-04T12:00:00Z", "B")];
    const fork = [mk("B", "2026-07-01T12:00:00Z")];
    const out = topoMergeCommits([trunk, branch, fork]).map((c) => c.hash);
    // B must come after BOTH of its children (T1 and F1).
    expect(out.indexOf("B")).toBeGreaterThan(out.indexOf("T1"));
    expect(out.indexOf("B")).toBeGreaterThan(out.indexOf("F1"));
    expect(out[0]).toBe("T2"); // newest ready commit first
    expect(out).toHaveLength(4);
  });

  it("dedupes commits that appear in more than one group", () => {
    const a = [mk("X", "2026-07-06T12:00:00Z", "Y"), mk("Y", "2026-07-05T12:00:00Z")];
    const b = [mk("Y", "2026-07-05T12:00:00Z")];
    expect(topoMergeCommits([a, b])).toHaveLength(2);
  });

  it("tolerates parents outside the fetched window (stubs)", () => {
    const out = topoMergeCommits([[mk("A", "2026-07-06T12:00:00Z", "missing")]]);
    expect(out.map((c) => c.hash)).toEqual(["A"]);
  });
});

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

describe("parseUnappliedUpstreams", () => {
  const row = (branch: string, upstream: string, track: string): string =>
    [branch, upstream, track].join("\t");

  it("keeps branches behind or diverged, and drops the rest", () => {
    expect(
      parseUnappliedUpstreams(
        [
          row("main", "origin/main", "<"),
          row("releases/1.0", "origin/releases/1.0", "<>"),
          row("in-sync", "origin/in-sync", "="),
          row("ahead-only", "origin/ahead-only", ">"),
          ""
        ].join("\n")
      )
    ).toEqual([
      { branch: "main", upstream: "origin/main" },
      { branch: "releases/1.0", upstream: "origin/releases/1.0" }
    ]);
  });

  it("skips branches with no upstream, and ones whose upstream is gone", () => {
    // A gone upstream reports an empty track field, same as a fresh branch
    // that never tracked anything — neither has fetched work to draw.
    expect(
      parseUnappliedUpstreams(
        [row("local-only", "", ""), row("stale", "origin/stale", ""), ""].join(
          "\n"
        )
      )
    ).toEqual([]);
  });

  it("tolerates CRLF, which git can emit through a Windows pipe", () => {
    expect(
      parseUnappliedUpstreams("feat/x\torigin/feat/x\t<>\r\nmain\torigin/main\t=\r\n")
    ).toEqual([{ branch: "feat/x", upstream: "origin/feat/x" }]);
  });
});

describe("parseRepoRefRows", () => {
  it("keeps upstream tracking metadata and tabbed subjects", () => {
    const rows = parseRepoRefRows(
      [
        "refs/heads/main",
        "main",
        "a".repeat(40),
        "origin/main",
        "[ahead 2, behind 3]",
        "2026-08-03T12:00:00-04:00",
        "subject\twith tab"
      ].join("\t")
    );
    expect(rows).toEqual([
      {
        fullName: "refs/heads/main",
        shortName: "main",
        head: "a".repeat(40),
        upstream: "origin/main",
        track: "[ahead 2, behind 3]",
        lastCommitAt: "2026-08-03T12:00:00-04:00",
        subject: "subject\twith tab"
      }
    ]);
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

describe("readCommit", () => {
  it("resolves an abbreviated SHA to one parsed commit", async () => {
    const hash = "a".repeat(40);
    const git: GitExec = async () =>
      ok({
        stdout: [
          hash,
          "b".repeat(40),
          "Harold",
          "harold@example.com",
          "2026-08-07T12:00:00Z",
          "feat: found outside graph"
        ].join("\x1f") + "\x1e",
        stderr: "",
        exitCode: 0
      });

    await expect(readCommit(git, "/repo", "aaaaaaa")).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ hash, shortHash: "aaaaaaa" })
    });
  });

  it("treats missing, ambiguous, and non-SHA queries as misses", async () => {
    let calls = 0;
    const git: GitExec = async () => {
      calls += 1;
      return ok({ stdout: "", stderr: "not a unique object", exitCode: 128 });
    };

    await expect(readCommit(git, "/repo", "deadbee")).resolves.toEqual({
      ok: true,
      value: null
    });
    await expect(readCommit(git, "/repo", "not-a-sha")).resolves.toEqual({
      ok: true,
      value: null
    });
    expect(calls).toBe(1);
  });

  it("rejects an all-hex ref whose target does not match the SHA prefix", async () => {
    const git: GitExec = async () =>
      ok({
        stdout: [
          "a".repeat(40),
          "",
          "Harold",
          "harold@example.com",
          "2026-08-07T12:00:00Z",
          "tip of the deadbeef branch"
        ].join("\x1f") + "\x1e",
        stderr: "",
        exitCode: 0
      });

    await expect(readCommit(git, "/repo", "deadbeef")).resolves.toEqual({
      ok: true,
      value: null
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

  it("reads status without taking Git's optional index lock", async () => {
    const git: GitExec = async (args, _cwd, options) => {
      expect(options?.env?.["GIT_OPTIONAL_LOCKS"]).toBe("0");
      expect(args).toContain("--ignore-submodules=dirty");
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    };

    await expect(readChanges(git, "/repo")).resolves.toEqual(
      ok({ staged: [], unstaged: [] })
    );
  });

  it("uses a child-aware status for live checkout safety", async () => {
    const git: GitExec = async (args, _cwd, options) => {
      expect(options?.env?.["GIT_OPTIONAL_LOCKS"]).toBe("0");
      expect(args).toEqual([
        "status",
        "--porcelain=v2",
        "--untracked-files=normal",
        "--ignore-submodules=none"
      ]);
      return ok({
        stdout:
          "1 .M S.M. 160000 160000 160000 aaa aaa modules/child\n",
        stderr: "",
        exitCode: 0
      });
    };

    await expect(readCheckoutDirtyCount(git, "/repo")).resolves.toEqual(ok(1));
  });
});
