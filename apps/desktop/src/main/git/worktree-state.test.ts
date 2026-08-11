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
    expect(state?.defaultBranch).toBe("main");
    expect(service.getCached(worktreeId)?.defaultBranch).toBe("main");
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

  // An agent or terminal switching branches never goes through PwrGit; the
  // sidebar/header labels read the worktrees.branch column, so a state refresh
  // must reconcile that column with the live checkout or the labels stick to
  // whatever the last full rescan saw.
  it("heals the worktrees.branch label when the checkout moved externally", async () => {
    git(repoPath, ["switch", "-c", "feature/agent-work"]);
    const state = await service.compute(worktreeId);
    expect(state?.branch).toBe("feature/agent-work");
    const row = db
      .prepare("SELECT branch FROM worktrees WHERE id = ?")
      .get(worktreeId) as { branch: string };
    expect(row.branch).toBe("feature/agent-work");
  });

  it("labels an external detached checkout like the indexer does", async () => {
    git(repoPath, ["checkout", "--detach"]);
    const state = await service.compute(worktreeId);
    const head = state?.head ?? "";
    expect(head).not.toBe("");
    expect(state?.branch).toBe(`detached@${head.slice(0, 7)}`);
    const row = db
      .prepare("SELECT branch FROM worktrees WHERE id = ?")
      .get(worktreeId) as { branch: string };
    expect(row.branch).toBe(`detached@${head.slice(0, 7)}`);
    git(repoPath, ["switch", "main"]);
  });

  // Windows can't delete a directory that is any process's cwd; the removal
  // lock is what keeps state probes (git spawned with cwd in the worktree)
  // and `git worktree remove` mutually exclusive.
  describe("removal lock", () => {
    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    it("drains the in-flight probe before granting the lock", async () => {
      const gate = deferred();
      const gatedGit: GitExec = async (args, cwd) => {
        if (args[0] === "status") await gate.promise;
        return systemGit(args, cwd);
      };
      const svc = new WorktreeStateService(db, gatedGit);

      const probe = svc.compute(worktreeId);
      let locked = false;
      const lock = svc.lockForRemoval(worktreeId).then((release) => {
        locked = true;
        return release;
      });
      await new Promise((r) => setTimeout(r, 25));
      expect(locked).toBe(false);

      gate.resolve();
      const release = await lock;
      expect(locked).toBe(true);
      expect(await probe).not.toBeNull();
      release();
    });

    it("drops probes while locked and resumes after release", async () => {
      let spawns = 0;
      const countingGit: GitExec = (args, cwd) => {
        spawns += 1;
        return systemGit(args, cwd);
      };
      const svc = new WorktreeStateService(db, countingGit);
      await svc.compute(worktreeId); // seed the cache
      const seeded = spawns;

      const release = await svc.lockForRemoval(worktreeId);
      const state = await svc.compute(worktreeId);
      expect(spawns).toBe(seeded);
      expect(state).toEqual(svc.getCached(worktreeId));

      release();
      expect(await svc.compute(worktreeId)).not.toBeNull();
      expect(spawns).toBeGreaterThan(seeded);
    });

    it("stays locked until every overlapping lock is released", async () => {
      let spawns = 0;
      const countingGit: GitExec = (args, cwd) => {
        spawns += 1;
        return systemGit(args, cwd);
      };
      const svc = new WorktreeStateService(db, countingGit);
      const releaseA = await svc.lockForRemoval(worktreeId);
      const releaseB = await svc.lockForRemoval(worktreeId);

      releaseA();
      releaseA(); // double-release must not unlock the other holder
      await svc.compute(worktreeId);
      expect(spawns).toBe(0);

      releaseB();
      await svc.compute(worktreeId);
      expect(spawns).toBeGreaterThan(0);
    });
  });
});
