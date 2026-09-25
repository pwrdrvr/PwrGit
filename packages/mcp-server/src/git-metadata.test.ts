import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand, type CommandRunner } from "./command.js";
import {
  parsePorcelainStatus,
  readRepositoryInfo
} from "./git-metadata.js";

const cleanup: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("safe repository metadata", () => {
  it("parses aggregate porcelain-v2 status without retaining filenames", () => {
    const parsed = parsePorcelainStatus(
      [
        "# branch.oid abc",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
        "1 M. N... 100644 100644 100644 a b secret.txt",
        "? private.env",
        "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
        ""
      ].join("\0")
    );
    expect(parsed).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
      stagedFiles: 1,
      untrackedFiles: 1,
      conflictedFiles: 1,
      changedFiles: 2,
      clean: false
    });
    expect(JSON.stringify(parsed)).not.toContain("secret.txt");
    expect(JSON.stringify(parsed)).not.toContain("private.env");
  });

  it("returns canonical identity, upstream evidence, worktrees, and safe counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-info-"));
    cleanup.push(root);
    const primary = join(root, "primary");
    const linked = join(root, "linked");
    execFileSync("git", ["init", "-b", "main", primary], { stdio: "ignore" });
    git(primary, ["config", "user.name", "PwrGit Test"]);
    git(primary, ["config", "user.email", "pwrgit@example.test"]);
    git(primary, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(primary, "tracked.txt"), "one\n");
    git(primary, ["add", "tracked.txt"]);
    git(primary, ["commit", "-m", "initial"]);
    git(primary, ["remote", "add", "origin", "git@github.com:fork/widget.git"]);
    git(primary, [
      "remote",
      "add",
      "upstream",
      "https://oauth2:never-return@github.com/acme/widget.git"
    ]);
    git(primary, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(primary, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(primary, ["worktree", "add", "-b", "feature/live", linked]);
    appendFileSync(join(primary, "tracked.txt"), "two\n");
    git(primary, ["add", "tracked.txt"]);
    writeFileSync(join(primary, "private.env"), "TOKEN=secret\n");

    const info = await readRepositoryInfo(primary);
    const canonicalPrimary = await realpath(primary);
    const canonicalLinked = await realpath(linked);
    expect(info).toMatchObject({
      requestedPath: canonicalPrimary,
      repositoryPath: canonicalPrimary,
      currentBranch: "main",
      defaultBranch: "main",
      canonicalRemote: {
        provider: "github",
        host: "github.com",
        path: "fork/widget",
        name: "origin",
        role: "canonical"
      },
      fork: {
        isFork: true,
        upstream: { provider: "github", host: "github.com", path: "acme/widget" },
        evidence: "upstream_remote"
      },
      worktreeCount: 2,
      status: { stagedFiles: 1, untrackedFiles: 1, clean: false }
    });
    expect(info.worktrees.map((worktree) => worktree.path)).toEqual([
      canonicalPrimary,
      canonicalLinked
    ]);
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("never-return");
    expect(serialized).not.toContain("private.env");
    expect(serialized).not.toContain("tracked.txt");
  });

  it("does not mislabel the current branch as an unknown default branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-default-"));
    cleanup.push(root);
    execFileSync("git", ["init", "-b", "topic", root], { stdio: "ignore" });
    git(root, ["config", "user.name", "PwrGit Test"]);
    git(root, ["config", "user.email", "pwrgit@example.test"]);
    writeFileSync(join(root, "tracked.txt"), "one\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);

    const info = await readRepositoryInfo(root);

    expect(info.currentBranch).toBe("topic");
    expect(info.defaultBranch).toBeNull();
  });
  it("bounds returned worktrees while aggregating every inspected one", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-bounded-"));
    cleanup.push(root);
    const primary = join(root, "primary");
    execFileSync("git", ["init", "-b", "main", primary], { stdio: "ignore" });
    git(primary, ["config", "user.name", "PwrGit Test"]);
    git(primary, ["config", "user.email", "pwrgit@example.test"]);
    writeFileSync(join(primary, "tracked.txt"), "one\n");
    git(primary, ["add", "tracked.txt"]);
    git(primary, ["commit", "-m", "initial"]);
    for (let index = 0; index < 5; index += 1) {
      git(primary, [
        "worktree",
        "add",
        "-b",
        `topic/${index}`,
        join(root, `linked-${index}`)
      ]);
    }
    // One linked worktree is dirty; the ranking must surface it even though
    // three clean worktrees precede it in git's own listing order.
    writeFileSync(join(root, "linked-4", "scratch.txt"), "dirty\n");

    const info = await readRepositoryInfo(primary, undefined, { maxWorktrees: 2 });

    expect(info.worktreeCount).toBe(6);
    expect(info.worktreesReturned).toBe(2);
    expect(info.worktreesTruncated).toBe(true);
    expect(info.worktrees).toHaveLength(2);
    expect(info.worktreeSummary).toMatchObject({
      inspected: 6,
      clean: 5,
      dirty: 1,
      conflicted: 0,
      withOperation: 0
    });
    // Primary leads, then the one worktree that needs attention.
    expect(info.worktrees[0]?.primary).toBe(true);
    expect(info.worktrees[1]?.path).toBe(await realpath(join(root, "linked-4")));
    expect(info.worktrees[1]?.status?.clean).toBe(false);
  });

  it("reports no truncation when every worktree fits", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-untruncated-"));
    cleanup.push(root);
    execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
    git(root, ["config", "user.name", "PwrGit Test"]);
    git(root, ["config", "user.email", "pwrgit@example.test"]);
    writeFileSync(join(root, "tracked.txt"), "one\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "initial"]);

    const info = await readRepositoryInfo(root);

    expect(info.worktreeCount).toBe(1);
    expect(info.worktreesReturned).toBe(1);
    expect(info.worktreesTruncated).toBe(false);
    expect(info.worktreeSummary.inspected).toBe(1);
  });

  it("reports a gone checkout as missing instead of failing the whole call", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-missing-"));
    cleanup.push(root);
    const primary = join(root, "primary");
    execFileSync("git", ["init", "-b", "main", primary], { stdio: "ignore" });
    git(primary, ["config", "user.name", "PwrGit Test"]);
    git(primary, ["config", "user.email", "pwrgit@example.test"]);
    writeFileSync(join(primary, "tracked.txt"), "one\n");
    git(primary, ["add", "tracked.txt"]);
    git(primary, ["commit", "-m", "initial"]);
    const paths = {
      live: join(root, "live"),
      deleted: join(root, "deleted"),
      unlinked: join(root, "unlinked"),
      nested: join(primary, "nested"),
      locked: join(root, "locked")
    };
    for (const [name, path] of Object.entries(paths)) {
      git(primary, ["worktree", "add", "-b", `topic/${name}`, path]);
    }
    // The folder is gone: git answers "cannot change to '<path>'".
    rmSync(paths.deleted, { recursive: true, force: true });
    // An interrupted removal took the `.git` link and left the folder: git
    // answers "not a git repository".
    rmSync(join(paths.unlinked, ".git"));
    // The same inside another checkout, where git would quietly answer for
    // that checkout instead of failing.
    rmSync(join(paths.nested, ".git"));
    // Git never reports a locked worktree prunable, even with its folder gone.
    git(primary, ["worktree", "lock", paths.locked]);
    rmSync(paths.locked, { recursive: true, force: true });

    const info = await readRepositoryInfo(primary, undefined, { maxWorktrees: 64 });

    const byBranch = new Map(info.worktrees.map((worktree) => [worktree.branch, worktree]));
    for (const name of ["deleted", "unlinked", "nested", "locked"]) {
      expect(byBranch.get(`topic/${name}`), name).toMatchObject({ missing: true, status: null });
    }
    expect(byBranch.get("topic/locked")).toMatchObject({ locked: true, prunable: false });
    expect(byBranch.get("topic/live")).toMatchObject({
      missing: false,
      status: { branch: "topic/live", clean: true }
    });
    // The primary is dirty only because the nested folder is now untracked.
    expect(info.worktreeSummary).toMatchObject({
      inspected: 6,
      clean: 1,
      dirty: 1,
      missing: 4,
      prunable: 3,
      locked: 1
    });
    const bounded = await readRepositoryInfo(primary, undefined, { maxWorktrees: 2 });
    expect(bounded.worktrees[1]?.missing).toBe(true);
  });

  it("treats a checkout removed mid-read as missing and still surfaces live failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-mcp-race-"));
    cleanup.push(root);
    const primary = join(root, "primary");
    execFileSync("git", ["init", "-b", "main", primary], { stdio: "ignore" });
    git(primary, ["config", "user.name", "PwrGit Test"]);
    git(primary, ["config", "user.email", "pwrgit@example.test"]);
    writeFileSync(join(primary, "tracked.txt"), "one\n");
    git(primary, ["add", "tracked.txt"]);
    git(primary, ["commit", "-m", "initial"]);
    git(primary, ["worktree", "add", "-b", "topic/live", join(root, "live")]);
    git(primary, ["worktree", "add", "-b", "topic/vanishing", join(root, "vanishing")]);
    const live = await realpath(join(root, "live"));
    const vanishing = await realpath(join(root, "vanishing"));

    // Removed after the existence check, before git reads it.
    const racing: CommandRunner = async (command, args, options) => {
      if (args[0] === "status" && options.cwd === vanishing) {
        rmSync(vanishing, { recursive: true, force: true });
      }
      return runCommand(command, args, options);
    };
    const info = await readRepositoryInfo(primary, racing);
    expect(info.worktrees.find((worktree) => worktree.branch === "topic/vanishing"))
      .toMatchObject({ missing: true, status: null });

    const failing: CommandRunner = async (command, args, options) =>
      args[0] === "status" && options.cwd === live
        ? { exitCode: 128, stdout: "", stderr: "fatal: index file corrupt" }
        : runCommand(command, args, options);
    await expect(readRepositoryInfo(primary, failing)).rejects.toThrow("index file corrupt");
  });
});
