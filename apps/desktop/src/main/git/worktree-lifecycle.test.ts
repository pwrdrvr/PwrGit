import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec, GitOutput } from "./dugite";
import { worktreeAdd, worktreeRemove } from "./git-service";
import { RepoIndexer } from "./repo-indexer";

const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 }))
    );
    proc.on("error", (e) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: e.message }))
    );
  });

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

let root: string;
let db: DB;
let indexer: RepoIndexer;
let profileId: string;
let repoId: string;
let repoPath: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-wtlife-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "Tester"]);
  writeFileSync(join(repo, "a.txt"), "1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "c1"]);

  db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  profileId = profiles.create({ name: "T", email: "t@t.com" }).id;
  indexer = new RepoIndexer(db, systemGit);
  const added = await indexer.indexRepoAt(profileId, repo);
  if (!added.ok) throw new Error("index failed");
  repoId = added.value.id;
  repoPath = added.value.path;
});

describe("worktree lifecycle", () => {
  it("creates and indexes a worktree, then removes it", async () => {
    const add = await worktreeAdd(
      systemGit,
      repoPath,
      join(root, "wt-feat"),
      "feat",
      { newBranch: true }
    );
    expect(add.ok).toBe(true);

    await indexer.refreshRepoWorktrees(repoId);
    let repos = indexer.listRepos(profileId);
    expect(repos[0]?.worktrees).toHaveLength(2);
    const feat = repos[0]?.worktrees.find((w) => w.branch === "feat");
    expect(feat).toBeDefined();

    const remove = await worktreeRemove(systemGit, repoPath, feat?.path ?? "", {
      force: false
    });
    expect(remove.ok).toBe(true);

    await indexer.refreshRepoWorktrees(repoId);
    repos = indexer.listRepos(profileId);
    expect(repos[0]?.worktrees).toHaveLength(1);
  });

  it("persists a custom worktree order", async () => {
    await worktreeAdd(systemGit, repoPath, join(root, "wt-x"), "x", {
      newBranch: true
    });
    await indexer.refreshRepoWorktrees(repoId);

    const before = indexer.listRepos(profileId)[0]?.worktrees ?? [];
    const ids = before.map((w) => w.id);
    const reversed = [...ids].reverse();
    indexer.setWorktreeOrder(repoId, reversed);

    const after = indexer.listRepos(profileId)[0]?.worktrees ?? [];
    expect(after.map((w) => w.id)).toEqual(reversed);
    expect(after[0]?.order).toBe(0);
  });
});
