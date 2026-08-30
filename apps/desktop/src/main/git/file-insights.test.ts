import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  FILE_BLAME_MAX_BYTES,
  parseFileHistory,
  readFileBlame,
  readFileHistory
} from "./file-insights";

const systemGit: GitExec = (args, cwd, options) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const child = spawn("git", args, {
      cwd,
      signal: options?.signal,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null"
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
    );
    child.on("error", (cause) =>
      resolve(
        err({
          kind: "git",
          code: cause.name === "AbortError" ? "aborted" : "spawn_failed",
          message: cause.message
        })
      )
    );
  });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    },
    encoding: "utf8"
  }).trim();
}

function commitAs(
  cwd: string,
  message: string,
  author: { name: string; email: string }
): string {
  execFileSync("git", ["commit", "-m", message], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email
    },
    stdio: "ignore"
  });
  return git(cwd, "rev-parse", "HEAD");
}

/** Records every argv the module hands to Git, then delegates for real. */
function recording(): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    git: (args, cwd, options) => {
      calls.push([...args]);
      return systemGit(args, cwd, options);
    }
  };
}

const ADA = { name: "Ada Lovelace", email: "ada@example.test" };
const GRACE = { name: "Grace Hopper", email: "grace@example.test" };

let root: string;
let repo: string;
let editedCommit: string;
let deletedCommit: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-file-insights-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, "legacy"), { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");

  writeFileSync(join(repo, "legacy", "café.txt"), "alpha\nshared\n");
  git(repo, "add", "legacy/café.txt");
  commitAs(repo, "add the guide", ADA);

  mkdirSync(join(repo, "docs"), { recursive: true });
  git(repo, "mv", "legacy/café.txt", "docs/guide.txt");
  commitAs(repo, "move guide into docs", ADA);

  writeFileSync(
    join(repo, "docs", "guide.txt"),
    "alpha\nshared, clarified\nnew line\n"
  );
  git(repo, "add", "docs/guide.txt");
  editedCommit = commitAs(repo, "clarify the guide", GRACE);

  git(repo, "rm", "docs/guide.txt");
  deletedCommit = commitAs(repo, "remove obsolete guide", GRACE);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("rename-aware file history", () => {
  it("pages through a deletion, edits, and the path before a rename", async () => {
    const first = await readFileHistory(systemGit, repo, {
      path: "docs/guide.txt",
      context: { kind: "workingTree" },
      limit: 2
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.entries.map((entry) => entry.subject)).toEqual([
      "remove obsolete guide",
      "clarify the guide"
    ]);
    expect(first.value.entries[0]).toMatchObject({
      path: "docs/guide.txt",
      status: "D"
    });
    expect(first.value.nextCursor).not.toBeNull();
    const cursor = first.value.nextCursor;
    if (cursor === null) throw new Error("expected another history page");

    const second = await readFileHistory(systemGit, repo, {
      path: "docs/guide.txt",
      context: { kind: "workingTree" },
      cursor,
      limit: 2
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.entries).toMatchObject([
      {
        subject: "move guide into docs",
        path: "docs/guide.txt",
        previousPath: "legacy/café.txt",
        status: "R"
      },
      {
        subject: "add the guide",
        path: "legacy/café.txt",
        status: "A"
      }
    ]);
    expect(second.value.nextCursor).toBeNull();
  });

  it("anchors later pages to the HEAD used by the first page", async () => {
    const first = await readFileHistory(systemGit, repo, {
      path: "docs/guide.txt",
      context: { kind: "workingTree" },
      limit: 1
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.nextCursor === null) return;
    expect(first.value.entries[0]?.subject).toBe("remove obsolete guide");

    try {
      mkdirSync(join(repo, "docs"), { recursive: true });
      writeFileSync(join(repo, "docs", "guide.txt"), "restored\n");
      git(repo, "add", "docs/guide.txt");
      commitAs(repo, "restore guide after paging began", ADA);

      const second = await readFileHistory(systemGit, repo, {
        path: "docs/guide.txt",
        context: { kind: "workingTree" },
        cursor: first.value.nextCursor,
        limit: 1
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.entries[0]?.subject).toBe("clarify the guide");
    } finally {
      git(repo, "reset", "--hard", deletedCommit);
    }
  });

  it("maps an uncommitted rename back to its HEAD path", async () => {
    writeFileSync(join(repo, "old-café.txt"), "kept line\n");
    git(repo, "add", "old-café.txt");
    const original = commitAs(repo, "add rename candidate", ADA);
    git(repo, "mv", "old-café.txt", "current.txt");

    const history = await readFileHistory(systemGit, repo, {
      path: "current.txt",
      context: { kind: "workingTree" }
    });
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.value.entries[0]).toMatchObject({
        hash: original,
        path: "old-café.txt",
        subject: "add rename candidate"
      });
    }

    const blame = await readFileBlame(systemGit, repo, {
      path: "current.txt",
      context: { kind: "workingTree" }
    });
    expect(blame.ok).toBe(true);
    if (blame.ok) {
      expect(blame.value.hunks[0]).toMatchObject({
        hash: original,
        authorName: "Ada Lovelace",
        lines: ["kept line"],
        uncommitted: false
      });
    }

    git(repo, "reset", "--hard", original);
  });
});

describe("bounded file blame", () => {
  it("shows commit identity and source paths across a rename", async () => {
    const result = await readFileBlame(systemGit, repo, {
      path: "docs/guide.txt",
      context: { kind: "commit", hash: editedCommit },
      limit: 2
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unavailableReason).toBeUndefined();
    expect(result.value.nextCursor).toBe("2");
    expect(result.value.hunks.flatMap((hunk) => hunk.lines)).toEqual([
      "alpha",
      "shared, clarified"
    ]);
    expect(result.value.hunks[0]).toMatchObject({
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.test",
      sourcePath: "legacy/café.txt",
      startLine: 1,
      endLine: 1
    });
    expect(result.value.hunks[1]).toMatchObject({
      authorName: "Grace Hopper",
      subject: "clarify the guide",
      startLine: 2,
      endLine: 2
    });
  });

  it("falls back to the parent contents for a deleted commit", async () => {
    const result = await readFileBlame(systemGit, repo, {
      path: "docs/guide.txt",
      context: { kind: "commit", hash: deletedCommit },
      limit: 10
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveContext).toEqual({
      kind: "commit",
      hash: editedCommit
    });
    expect(result.value.notice).toContain("deleted in the selected commit");
    expect(result.value.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(3);
  });

  it("marks an untracked working-tree file as wholly uncommitted", async () => {
    writeFileSync(join(repo, "draft.txt"), "draft one\ndraft two\n");
    const result = await readFileBlame(systemGit, repo, {
      path: "draft.txt",
      context: { kind: "workingTree" },
      limit: 10
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        hunks: [
          {
            hash: null,
            authorName: "Uncommitted",
            startLine: 1,
            endLine: 2,
            lines: ["draft one", "draft two"]
          }
        ]
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "attributes an unchanged tracked symlink blob",
    async () => {
      symlinkSync("target.txt", join(repo, "guide-link"));
      git(repo, "add", "guide-link");
      const symlinkCommit = commitAs(repo, "add guide symlink", ADA);

      const result = await readFileBlame(systemGit, repo, {
        path: "guide-link",
        context: { kind: "workingTree" }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.unavailableReason).toBeUndefined();
      expect(result.value.hunks[0]).toMatchObject({
        hash: symlinkCommit,
        authorName: "Ada Lovelace",
        lines: ["target.txt"],
        uncommitted: false
      });
    }
  );

  it("refuses binary and oversized files without running blame", async () => {
    writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(
      join(repo, "huge.txt"),
      Buffer.alloc(FILE_BLAME_MAX_BYTES + 1, 97)
    );

    const binary = await readFileBlame(systemGit, repo, {
      path: "binary.dat",
      context: { kind: "workingTree" }
    });
    const huge = await readFileBlame(systemGit, repo, {
      path: "huge.txt",
      context: { kind: "workingTree" }
    });

    expect(binary).toMatchObject({
      ok: true,
      value: { unavailableReason: "binary", hunks: [] }
    });
    expect(huge).toMatchObject({
      ok: true,
      value: {
        unavailableReason: "too_large",
        bytes: FILE_BLAME_MAX_BYTES + 1,
        hunks: []
      }
    });
  });
});

describe("Git work a read is allowed to do", () => {
  // Its own repository: the shared fixture ends with the file deleted, and
  // these assertions are about the argv of a plain tracked-file read.
  let plainRoot: string;
  let plain: string;

  beforeAll(() => {
    plainRoot = mkdtempSync(join(tmpdir(), "pwrgit-file-insights-argv-"));
    plain = join(plainRoot, "repo");
    mkdirSync(join(plain, "src"), { recursive: true });
    git(plain, "init", "-b", "main");
    git(plain, "config", "core.autocrlf", "false");
    writeFileSync(join(plain, "src", "app.ts"), "alpha\nbeta\n");
    git(plain, "add", "src/app.ts");
    commitAs(plain, "add app", ADA);
  });

  afterAll(() => rmSync(plainRoot, { recursive: true, force: true }));

  it("skips the worktree status scan when HEAD already has the path", async () => {
    const { git: spy, calls } = recording();

    const result = await readFileBlame(spy, plain, {
      path: "src/app.ts",
      context: { kind: "workingTree" },
      limit: 10
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hunks[0]).toMatchObject({ uncommitted: false });
    // `git status` walks the whole worktree, and it was running on every
    // history and blame read purely to map an uncommitted rename.
    expect(calls.some((args) => args.includes("status"))).toBe(false);
  });

  it("still maps a rename that only the worktree knows about", async () => {
    git(plain, "mv", "src/app.ts", "src/renamed.ts");
    // Restored in `finally`: a failing assertion here used to leave the fixture
    // renamed, so the NEXT test failed for a reason that had nothing to do with
    // it and pointed at the wrong code.
    try {
      const { git: spy, calls } = recording();

      const result = await readFileBlame(spy, plain, {
        path: "src/renamed.ts",
        context: { kind: "workingTree" },
        limit: 10
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(calls.some((args) => args.includes("status"))).toBe(true);
      expect(result.value.unavailableReason).toBeUndefined();
      // Attributed to the commit that added it under its OLD name, not written
      // off as uncommitted.
      expect(result.value.hunks[0]).toMatchObject({
        uncommitted: false,
        authorName: "Ada Lovelace"
      });
    } finally {
      git(plain, "mv", "src/renamed.ts", "src/app.ts");
    }
  });

  it("does not ask Git for cross-file copy attribution", async () => {
    const { git: spy, calls } = recording();
    await readFileBlame(spy, plain, {
      path: "src/app.ts",
      context: { kind: "workingTree" },
      limit: 10
    });

    const blame = calls.find((args) => args.includes("blame"));
    expect(blame).toBeDefined();
    // -M (moves within this file) is wanted; -C attributed boilerplate to
    // whichever unrelated file the same commit happened to touch.
    expect(blame).toContain("-M");
    expect(blame).not.toContain("-C");
  });
});

describe("hardened history paging", () => {
  it("counts records Git returned, not rows that parsed", async () => {
    const FMT = "\x1e" + ["%H", "%P", "%an", "%ae", "%cI", "%s"].join("\0") + "\0";
    const record = (hash: string, status: string): string =>
      FMT.replace("%H", hash)
        .replace("%P", "")
        .replace("%an", "A")
        .replace("%ae", "a@a.test")
        .replace("%cI", "2025-01-01T00:00:00Z")
        .replace("%s", "s") + status;
    // Two commits, one of which carries no name-status and so parses to nothing.
    const stdout = record("a".repeat(40), "M\0f.txt\0") + record("b".repeat(40), "");

    // One pass reports both, so paging and rendering cannot disagree about
    // what counts as a record.
    expect(parseFileHistory(stdout)).toMatchObject({ records: 2 });
    expect(parseFileHistory(stdout).entries).toHaveLength(1);
  });

  it("refuses a cursor whose lineage path escapes the worktree", async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        offset: 0,
        revision: editedCommit,
        lineagePath: "../../etc/passwd",
        selectedPath: "docs/guide.txt",
        context: editedCommit
      }),
      "utf8"
    ).toString("base64url");

    const result = await readFileHistory(systemGit, repo, {
      path: "docs/guide.txt",
      context: { kind: "commit", hash: editedCommit },
      cursor
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "invalid_path" }
    });
  });

  it("reads pathspecs literally, so a magic prefix cannot widen the query", async () => {
    const { git: spy, calls } = recording();
    await readFileHistory(spy, repo, {
      path: "docs/guide.txt",
      context: { kind: "commit", hash: editedCommit }
    });
    const log = calls.find((args) => args.includes("log"));
    expect(log).toContain("--literal-pathspecs");
  });
});

