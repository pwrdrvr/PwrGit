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
});
