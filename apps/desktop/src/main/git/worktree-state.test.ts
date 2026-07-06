import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec, GitOutput } from "./dugite";
import { RepoIndexer } from "./repo-indexer";
import { parseStatus, WorktreeStateService } from "./worktree-state";

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

describe("parseStatus", () => {
  it("reads a clean repo with no upstream", () => {
    const s = parseStatus(
      ["# branch.oid abc123", "# branch.head main", ""].join("\n")
    );
    expect(s).toEqual({
      head: "abc123",
      branch: "main",
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      dirty: 0
    });
  });

  it("reads ahead/behind from branch.ab and upstream presence", () => {
    const s = parseStatus(
      [
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
        ""
      ].join("\n")
    );
    expect(s.hasUpstream).toBe(true);
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(3);
  });

  it("counts changed + untracked entries as dirty", () => {
    const s = parseStatus(
      [
        "# branch.oid abc123",
        "# branch.head main",
        "1 .M N... 100644 100644 100644 aaa bbb file1.txt",
        "1 M. N... 100644 100644 100644 ccc ddd file2.txt",
        "? untracked.txt",
        ""
      ].join("\n")
    );
    expect(s.dirty).toBe(3);
  });

  it("labels detached HEAD", () => {
    const s = parseStatus(
      ["# branch.oid abc123", "# branch.head (detached)", ""].join("\n")
    );
    expect(s.branch).toBe("(detached)");
  });
});

describe("WorktreeStateService (system git)", () => {
  let db: DB;
  let service: WorktreeStateService;
  let worktreeId: string;
  let repoPath: string;

  beforeAll(async () => {
    repoPath = join(mkdtempSync(join(tmpdir(), "pwrgit-state-")), "repo");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.email", "t@t.com"]);
    git(repoPath, ["config", "user.name", "Tester"]);
    writeFileSync(join(repoPath, "README.md"), "# repo\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "init"]);

    db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    const p = profiles.create({ name: "T", email: "t@t.com" });
    const indexer = new RepoIndexer(db, systemGit);
    const added = await indexer.indexRepoAt(p.id, repoPath);
    if (!added.ok) throw new Error("indexRepoAt failed");
    const primary =
      added.value.worktrees.find((w) => w.isPrimary) ??
      added.value.worktrees[0];
    if (primary === undefined) throw new Error("worktree not indexed");
    worktreeId = primary.id;
    // git resolves the realpath (macOS /var → /private/var); use it for writes.
    repoPath = primary.path;
    service = new WorktreeStateService(db, systemGit);
  });

  it("computes a clean worktree: dirty 0, HEAD set, last-activity set", async () => {
    const state = await service.compute(worktreeId);
    expect(state).not.toBeNull();
    expect(state?.dirty).toBe(0);
    expect(state?.head).not.toBe("");
    expect(state?.hasUpstream).toBe(false);
    expect(state?.lastActivityAt).toBeTruthy();
  });

  it("reflects a working-tree edit as dirty, and caches it", async () => {
    writeFileSync(join(repoPath, "changed.txt"), "hello\n");
    const state = await service.compute(worktreeId);
    expect(state?.dirty).toBe(1);
    expect(service.getCached(worktreeId)?.dirty).toBe(1);
  });

  it("returns null for an unknown worktree id", async () => {
    expect(await service.compute("nope")).toBeNull();
    expect(service.getCached("nope")).toBeNull();
  });
});
