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
