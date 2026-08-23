import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { deleteLocalBranch, renameLocalBranch } from "./branch-lifecycle";

const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    proc.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
    );
    proc.on("error", (error) =>
      resolve(
        err({ kind: "git", code: "spawn_failed", message: error.message })
      )
    );
  });

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, file: string, message: string): void {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
}

let roots: string[] = [];

function repo(name: string): { root: string; path: string } {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), `pwrgit-branch-${name}-`))
  );
  roots.push(root);
  const path = join(root, "repo");
  mkdirSync(path);
  git(path, "init", "-b", "main");
  git(path, "config", "user.email", "test@pwrgit.dev");
  git(path, "config", "user.name", "PwrGit Test");
  git(path, "config", "core.autocrlf", "false");
  commit(path, "initial.txt", "initial");
  return { root, path };
}

function head(cwd: string, branch: string): string {
  return gitOut(cwd, "rev-parse", `refs/heads/${branch}`);
}

function hasRef(cwd: string, ref: string): boolean {
  try {
    git(cwd, "show-ref", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("safe local branch lifecycle", () => {
  it("renames a free local branch and preserves its upstream", async () => {
    const { root, path } = repo("rename-upstream");
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", remote);
    git(path, "remote", "add", "origin", remote);
    git(path, "branch", "topic");
    git(path, "push", "-u", "origin", "topic");
    const expectedHead = head(path, "topic");

    const result = await renameLocalBranch(
      systemGit,
      path,
      { branch: "topic", expectedHead },
      "feature/topic"
    );

    expect(result).toEqual(ok(undefined));
    expect(hasRef(path, "refs/heads/topic")).toBe(false);
    expect(head(path, "feature/topic")).toBe(expectedHead);
    expect(gitOut(path, "config", "branch.feature/topic.remote")).toBe(
      "origin"
    );
    expect(gitOut(path, "config", "branch.feature/topic.merge")).toBe(
      "refs/heads/topic"
    );
    // Renaming the local branch never renames its published counterpart.
    expect(gitOut(path, "ls-remote", "--heads", "origin", "topic")).not.toBe(
      ""
    );
  });

  it("guards the current branch and branches held by another worktree", async () => {
    const { root, path } = repo("occupied");
    git(path, "branch", "linked");
    const linkedPath = join(root, "linked");
    git(path, "worktree", "add", linkedPath, "linked");

    const current = await deleteLocalBranch(systemGit, path, {
      branch: "main",
      expectedHead: head(path, "main")
    });
    const linked = await renameLocalBranch(
      systemGit,
      path,
      { branch: "linked", expectedHead: head(path, "linked") },
      "renamed"
    );

    expect(!current.ok && current.error.code).toBe("branch_checked_out");
    expect(!linked.ok && linked.error.code).toBe("branch_checked_out");
    expect(!linked.ok && linked.error.message).toContain(linkedPath);
  });

  it("does not treat a detached worktree as occupying its former branch", async () => {
    const { root, path } = repo("detached");
    git(path, "branch", "release");
    const linkedPath = join(root, "detached-worktree");
    git(path, "worktree", "add", linkedPath, "release");
    git(linkedPath, "switch", "--detach");

    const result = await deleteLocalBranch(systemGit, path, {
      branch: "release",
      expectedHead: head(path, "release")
    });

    expect(result).toEqual(ok(undefined));
    expect(hasRef(path, "refs/heads/release")).toBe(false);
  });

  it("normal-deletes merged work and requires force for unique commits", async () => {
    const { root, path } = repo("merged-unmerged");
    git(path, "branch", "merged");
    expect(
      await deleteLocalBranch(systemGit, path, {
        branch: "merged",
        expectedHead: head(path, "merged")
      })
    ).toEqual(ok(undefined));

    git(path, "branch", "unmerged");
    const worktree = join(root, "unmerged-worktree");
    git(path, "worktree", "add", worktree, "unmerged");
    commit(worktree, "unique.txt", "unique work");
    git(path, "worktree", "remove", worktree);
    const expectedHead = head(path, "unmerged");

    const normal = await deleteLocalBranch(systemGit, path, {
      branch: "unmerged",
      expectedHead
    });
    expect(!normal.ok && normal.error.code).toBe("unmerged");
    expect(hasRef(path, "refs/heads/unmerged")).toBe(true);

    expect(
      await deleteLocalBranch(
        systemGit,
        path,
        { branch: "unmerged", expectedHead },
        true
      )
    ).toEqual(ok(undefined));
    expect(hasRef(path, "refs/heads/unmerged")).toBe(false);
  });

  it("lets Git use a configured upstream as the normal-delete merge authority", async () => {
    const { root, path } = repo("delete-upstream");
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", remote);
    git(path, "remote", "add", "origin", remote);
    git(path, "branch", "published");
    const worktree = join(root, "published-worktree");
    git(path, "worktree", "add", worktree, "published");
    commit(worktree, "published.txt", "published work");
    git(worktree, "push", "-u", "origin", "published");
    git(path, "worktree", "remove", worktree);
    const expectedHead = head(path, "published");

    const result = await deleteLocalBranch(systemGit, path, {
      branch: "published",
      expectedHead
    });

    expect(result).toEqual(ok(undefined));
    expect(hasRef(path, "refs/heads/published")).toBe(false);
    expect(
      gitOut(path, "ls-remote", "--heads", "origin", "published")
    ).not.toBe("");
  });

  it("rejects invalid and ref-conflicting rename targets", async () => {
    const { path } = repo("invalid");
    git(path, "branch", "source");
    git(path, "branch", "topic");
    const expectedHead = head(path, "source");

    const invalid = await renameLocalBranch(
      systemGit,
      path,
      { branch: "source", expectedHead },
      "bad name"
    );
    const conflict = await renameLocalBranch(
      systemGit,
      path,
      { branch: "source", expectedHead },
      "topic/child"
    );

    expect(!invalid.ok && invalid.error.code).toBe("invalid_branch");
    expect(!conflict.ok && conflict.error.code).toBe("ref_conflict");
    expect(hasRef(path, "refs/heads/source")).toBe(true);
  });

  it("never confuses a remote-tracking ref with a local branch", async () => {
    const { path } = repo("remote-only");
    const expectedHead = head(path, "main");
    git(
      path,
      "update-ref",
      "refs/remotes/origin/remote-only",
      expectedHead
    );

    const result = await deleteLocalBranch(systemGit, path, {
      branch: "origin/remote-only",
      expectedHead
    });

    expect(!result.ok && result.error.code).toBe("remote_branch");
    expect(hasRef(path, "refs/remotes/origin/remote-only")).toBe(true);
  });

  it("rejects a tip changed by another Git client after the reviewed snapshot", async () => {
    const { path } = repo("stale");
    git(path, "branch", "stale");
    const reviewedHead = head(path, "stale");
    commit(path, "later.txt", "later");
    git(path, "branch", "-f", "stale", "HEAD");

    const result = await deleteLocalBranch(systemGit, path, {
      branch: "stale",
      expectedHead: reviewedHead
    });

    expect(!result.ok && result.error.code).toBe("stale_branch");
    expect(hasRef(path, "refs/heads/stale")).toBe(true);
  });

  it("blocks branch mutations while a Git operation is in progress", async () => {
    const { path } = repo("operation");
    git(path, "branch", "safe");
    writeFileSync(join(path, ".git", "MERGE_HEAD"), `${head(path, "main")}\n`);

    const result = await deleteLocalBranch(systemGit, path, {
      branch: "safe",
      expectedHead: head(path, "safe")
    });

    expect(!result.ok && result.error.code).toBe("operation_in_progress");
    expect(!result.ok && result.error.message).toContain("merge");
    expect(hasRef(path, "refs/heads/safe")).toBe(true);
  });
});
