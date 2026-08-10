import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { discardAllChanges } from "./git-service";

const systemGit: GitExec = (args, cwd) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: cause.message }))
    );
    proc.on("close", (exitCode) =>
      resolve(ok({ stdout, stderr, exitCode: exitCode ?? 1 } satisfies GitOutput))
    );
  });

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("discardAllChanges (system git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-discard-all-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    git(repo, ["config", "core.autocrlf", "false"]);

    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    writeFileSync(join(repo, "tracked.txt"), "tracked baseline\n");
    writeFileSync(join(repo, "staged and modified.txt"), "mixed baseline\n");
    writeFileSync(join(repo, "deleted.txt"), "deleted baseline\n");
    writeFileSync(join(repo, "staged-delete.txt"), "staged delete baseline\n");
    writeFileSync(join(repo, "old name.txt"), "rename baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("restores all HEAD paths, removes untracked paths, and preserves ignored files", async () => {
    writeFileSync(join(repo, "tracked.txt"), "working change\n");
    writeFileSync(join(repo, "staged and modified.txt"), "staged change\n");
    git(repo, ["add", "staged and modified.txt"]);
    writeFileSync(join(repo, "staged and modified.txt"), "unstaged after staging\n");

    unlinkSync(join(repo, "deleted.txt"));
    unlinkSync(join(repo, "staged-delete.txt"));
    git(repo, ["add", "staged-delete.txt"]);
    git(repo, ["mv", "old name.txt", "renamed path.txt"]);

    writeFileSync(join(repo, "staged add.txt"), "new and staged\n");
    git(repo, ["add", "staged add.txt"]);
    writeFileSync(join(repo, "loose file.txt"), "untracked\n");
    mkdirSync(join(repo, "new folder"));
    writeFileSync(join(repo, "new folder", "nested file.txt"), "untracked directory\n");
    mkdirSync(join(repo, "ignored"));
    writeFileSync(join(repo, "ignored", "cache.bin"), "keep me\n");

    const calls: string[][] = [];
    const countingGit: GitExec = (args, cwd) => {
      calls.push([...args]);
      return systemGit(args, cwd);
    };

    await expect(discardAllChanges(countingGit, repo)).resolves.toEqual(
      ok(undefined)
    );

    expect(calls).toEqual([
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."],
      ["clean", "-fd"]
    ]);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(
      "tracked baseline\n"
    );
    expect(readFileSync(join(repo, "staged and modified.txt"), "utf8")).toBe(
      "mixed baseline\n"
    );
    expect(readFileSync(join(repo, "deleted.txt"), "utf8")).toBe(
      "deleted baseline\n"
    );
    expect(readFileSync(join(repo, "staged-delete.txt"), "utf8")).toBe(
      "staged delete baseline\n"
    );
    expect(readFileSync(join(repo, "old name.txt"), "utf8")).toBe(
      "rename baseline\n"
    );
    expect(existsSync(join(repo, "renamed path.txt"))).toBe(false);
    expect(existsSync(join(repo, "staged add.txt"))).toBe(false);
    expect(existsSync(join(repo, "loose file.txt"))).toBe(false);
    expect(existsSync(join(repo, "new folder"))).toBe(false);
    expect(readFileSync(join(repo, "ignored", "cache.bin"), "utf8")).toBe(
      "keep me\n"
    );
    expect(git(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("clears staged and untracked paths in an unborn repo while preserving ignored files", async () => {
    const unborn = join(root, "unborn repo");
    mkdirSync(unborn);
    git(unborn, ["init", "-b", "main"]);
    writeFileSync(join(unborn, ".git", "info", "exclude"), "ignored/\n");

    writeFileSync(join(unborn, "staged add.txt"), "staged\n");
    git(unborn, ["add", "staged add.txt"]);
    writeFileSync(join(unborn, "loose file.txt"), "untracked\n");
    mkdirSync(join(unborn, "new folder"));
    writeFileSync(join(unborn, "new folder", "nested file.txt"), "untracked\n");
    mkdirSync(join(unborn, "ignored"));
    writeFileSync(join(unborn, "ignored", "cache.bin"), "keep me\n");

    const calls: string[][] = [];
    const countingGit: GitExec = (args, cwd) => {
      calls.push([...args]);
      return systemGit(args, cwd);
    };

    await expect(discardAllChanges(countingGit, unborn)).resolves.toEqual(
      ok(undefined)
    );

    expect(calls).toEqual([
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."],
      ["symbolic-ref", "--quiet", "HEAD"],
      ["show-ref", "--verify", "--quiet", "refs/heads/main"],
      ["read-tree", "--empty"],
      ["clean", "-fd"]
    ]);
    expect(existsSync(join(unborn, "staged add.txt"))).toBe(false);
    expect(existsSync(join(unborn, "loose file.txt"))).toBe(false);
    expect(existsSync(join(unborn, "new folder"))).toBe(false);
    expect(readFileSync(join(unborn, "ignored", "cache.bin"), "utf8")).toBe(
      "keep me\n"
    );
    expect(git(unborn, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      ""
    );
  });

  it("does not clear recoverable data when a symbolic HEAD ref is corrupt", async () => {
    const head = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "tracked.txt"), "recoverable worktree change\n");
    writeFileSync(join(repo, "loose file.txt"), "recoverable untracked file\n");
    unlinkSync(join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)));

    const calls: string[][] = [];
    const countingGit: GitExec = (args, cwd) => {
      calls.push([...args]);
      return systemGit(args, cwd);
    };

    const result = await discardAllChanges(countingGit, repo);

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."],
      ["symbolic-ref", "--quiet", "HEAD"],
      ["show-ref", "--verify", "--quiet", "refs/heads/main"]
    ]);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(
      "recoverable worktree change\n"
    );
    expect(readFileSync(join(repo, "loose file.txt"), "utf8")).toBe(
      "recoverable untracked file\n"
    );
    expect(git(repo, ["ls-files", "--error-unmatch", "tracked.txt"])).toBe(
      "tracked.txt"
    );
  });
});
