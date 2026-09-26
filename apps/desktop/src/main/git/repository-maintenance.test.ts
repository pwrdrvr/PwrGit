import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StaleBranch } from "@pwrgit/shared";
import { createSystemGit } from "./test-support/system-git";
import {
  collectGarbage,
  deleteStaleBranch,
  garbageCollectionArgs,
  maintenanceCommonDirectory,
  objectStorageBytes,
  scanStaleBranches
} from "./repository-maintenance";

const systemGit = createSystemGit();
const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function fixture(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-maintenance-")));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Maintenance Test");
  git(repo, "config", "user.email", "maintenance@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "tracked.txt"), "keep me\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Initial commit");
  git(root, "init", "--bare", "remote.git");
  git(repo, "remote", "add", "origin", join(root, "remote.git"));
  git(repo, "push", "-u", "origin", "main");
  return { root, repo };
}
function gone(repo: string, name: string): void {
  git(repo, "branch", name);
  git(repo, "push", "-u", "origin", name);
  git(repo, "push", "origin", "--delete", name);
}
async function review(repo: string): Promise<StaleBranch[]> {
  const result = await scanStaleBranches(systemGit, repo, "repo");
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("repository maintenance with real Git", () => {
  it("reports an empty review when the checkout has no local commits", async () => {
    const { repo } = fixture();
    git(repo, "update-ref", "-d", "refs/heads/main");
    expect(await review(repo)).toEqual([]);
  });
  it.each(["standard", "keep-largest", "aggressive"] as const)(
    "runs %s collection without changing refs or dirty files",
    async (mode) => {
      const { repo } = fixture();
      const refs = git(repo, "show-ref");
      writeFileSync(join(repo, "tracked.txt"), "local edits\n");
      writeFileSync(join(repo, "untracked.txt"), "also keep me\n");
      const status = git(repo, "status", "--porcelain");
      expect(await objectStorageBytes(systemGit, repo)).toBeGreaterThan(0);
      expect(await collectGarbage(systemGit, repo, mode)).toEqual({
        ok: true,
        value: undefined
      });
      expect(git(repo, "show-ref")).toBe(refs);
      expect(git(repo, "status", "--porcelain")).toBe(status);
      expect(await objectStorageBytes(systemGit, repo)).toBeGreaterThan(0);
      expect(garbageCollectionArgs(mode)).not.toContain("--prune=now");
    }
  );

  it("keeps missing worktree registrations even when user configuration expires them now", async () => {
    const { root, repo } = fixture();
    const worktree = join(root, "missing");
    git(repo, "worktree", "add", "-b", "held", worktree);
    rmSync(worktree, { recursive: true, force: true });
    git(repo, "config", "gc.worktreePruneExpire", "now");
    expect((await collectGarbage(systemGit, repo, "standard")).ok).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(
      "refs/heads/held"
    );
  });

  it("resolves linked worktrees to the same object store and refuses missing checkout metadata", async () => {
    const { root, repo } = fixture();
    const worktree = join(root, "linked");
    git(repo, "worktree", "add", "-b", "held", worktree);
    expect(await maintenanceCommonDirectory(systemGit, worktree)).toEqual(
      await maintenanceCommonDirectory(systemGit, repo)
    );
    const nested = join(repo, "nested");
    mkdirSync(nested);
    expect((await maintenanceCommonDirectory(systemGit, nested)).ok).toBe(
      false
    );
  });

  it("offers only merged, unoccupied local branches with a gone upstream", async () => {
    const { root, repo } = fixture();
    gone(repo, "finished");
    gone(repo, "develop");
    gone(repo, "held");
    git(repo, "worktree", "add", join(root, "held"), "held");
    git(repo, "branch", "no-upstream");
    git(repo, "branch", "live-upstream");
    git(repo, "push", "-u", "origin", "live-upstream");
    gone(repo, "unique");
    git(repo, "checkout", "unique");
    writeFileSync(join(repo, "unique.txt"), "unmerged\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Unique work");
    git(repo, "checkout", "main");
    expect((await review(repo)).map((branch) => branch.branch)).toEqual([
      "finished"
    ]);
  });

  it("deletes only the reviewed local branch and its tracking configuration", async () => {
    const { repo } = fixture();
    gone(repo, "finished");
    const candidate = (await review(repo))[0]!;
    expect((await deleteStaleBranch(systemGit, repo, candidate)).ok).toBe(true);
    expect(git(repo, "branch", "--list", "finished")).toBe("");
    expect(git(repo, "ls-remote", "--heads", "origin")).toContain(
      "refs/heads/main"
    );
    expect(git(repo, "config", "--list")).not.toContain("branch.finished.");
  });

  it.each(["moved", "upstream-restored", "checked-out"])(
    "retains a branch that became %s after review",
    async (change) => {
      const { root, repo } = fixture();
      gone(repo, "finished");
      const candidate = (await review(repo))[0]!;
      if (change === "moved") {
        git(repo, "commit", "--allow-empty", "-m", "Next commit");
        git(repo, "branch", "-f", "finished", "HEAD");
      } else if (change === "upstream-restored") {
        git(repo, "update-ref", "refs/remotes/origin/finished", "HEAD");
      } else git(repo, "worktree", "add", join(root, "held"), "finished");
      expect((await deleteStaleBranch(systemGit, repo, candidate)).ok).toBe(
        false
      );
      expect(git(repo, "branch", "--list", "finished")).toContain("finished");
    }
  );

  it("retains squash-merged tips whose original commit is not reachable", async () => {
    const { repo } = fixture();
    gone(repo, "squashed");
    git(repo, "checkout", "squashed");
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Feature");
    git(repo, "checkout", "main");
    git(repo, "merge", "--squash", "squashed");
    git(repo, "commit", "-m", "Squashed feature");
    expect(await review(repo)).toEqual([]);
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
  });
});
