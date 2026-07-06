import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result, type Worktree } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec, GitOutput } from "./dugite";
import { RepoIndexer } from "./repo-indexer";
import { WorktreeStateService } from "./worktree-state";

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

let db: DB;
let service: WorktreeStateService;
let byBranch: Map<string, Worktree>;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-stale-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "Tester"]);
  writeFileSync(join(repo, "a.txt"), "1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "c1"]);

  // A worktree fully merged into main (branched off c1, no new commits).
  git(repo, ["worktree", "add", join(root, "merged"), "-b", "merged"]);

  // A worktree with a unique commit not in main.
  const unmerged = join(root, "unmerged");
  git(repo, ["worktree", "add", unmerged, "-b", "unmerged"]);
  writeFileSync(join(unmerged, "b.txt"), "2\n");
  git(unmerged, ["add", "."]);
  git(unmerged, ["commit", "-m", "c2 unique"]);

  // Advance main so both branches fall behind the default branch.
  writeFileSync(join(repo, "c.txt"), "3\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "c3 on main"]);

  // An orphan branch: no shared history with main (rewritten/orphaned).
  git(repo, ["checkout", "--orphan", "orphan"]);
  git(repo, ["rm", "-rf", "."]);
  writeFileSync(join(repo, "o.txt"), "o\n");
  git(repo, ["add", "o.txt"]);
  git(repo, ["commit", "-m", "orphan root"]);
  git(repo, ["checkout", "main"]);
  git(repo, ["worktree", "add", join(root, "orphan"), "orphan"]);

  db = openDatabase(":memory:");
  const profiles = new ProfileService(db);
  const p = profiles.create({ name: "T", email: "t@t.com" });
  const indexer = new RepoIndexer(db, systemGit);
  const added = await indexer.indexRepoAt(p.id, repo);
  if (!added.ok) throw new Error("index failed");

  service = new WorktreeStateService(db, systemGit);
  for (const wt of added.value.worktrees) await service.compute(wt.id);

  const repos = indexer.listRepos(p.id);
  byBranch = new Map(repos[0]?.worktrees.map((w) => [w.branch, w]) ?? []);
});

describe("staleness signals", () => {
  it("resolves the default branch and flags the main worktree", () => {
    const main = byBranch.get("main");
    expect(main?.isDefaultBranch).toBe(true);
  });

  it("marks a merged, unmodified branch as merged into default", () => {
    const merged = byBranch.get("merged");
    expect(merged?.isDefaultBranch).toBe(false);
    expect(merged?.mergedIntoDefault).toBe(true);
    expect((merged?.behindDefault ?? 0) > 0).toBe(true);
  });

  it("does not mark a branch with unique commits as merged", () => {
    const unmerged = byBranch.get("unmerged");
    expect(unmerged?.mergedIntoDefault).toBe(false);
    expect((unmerged?.behindDefault ?? 0) > 0).toBe(true);
  });

  it("flags an orphan branch as diverged (not an inflated behind count)", () => {
    const orphan = byBranch.get("orphan");
    expect(orphan?.divergedFromDefault).toBe(true);
    expect(orphan?.mergedIntoDefault).toBe(false);
    expect(orphan?.behindDefault).toBe(0);
  });
});
