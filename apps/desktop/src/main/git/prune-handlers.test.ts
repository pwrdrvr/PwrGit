import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { err, ok, RECLAIM_DEFAULT_EXCLUDES } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec, GitOutput } from "./dugite";
import { worktreeAdd } from "./git-service";
import { registerPruneHandlers } from "./prune-handlers";
import { RepoIndexer } from "./repo-indexer";
import { createWorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { WorktreeStateService } from "./worktree-state";

vi.mock("../ipc", () => ({ registerIpc: vi.fn(), emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

const OLD_COMMIT_DATE = "2025-01-05T10:00:00+0000";

const systemGit: GitExec = (args, cwd, options) =>
  new Promise((resolve) => {
    // `-C`, never a native cwd inside a checkout this suite deletes.
    const proc = spawn("git", ["-C", cwd, ...args], {
      cwd: tmpdir(),
      env: { ...process.env, ...options?.env }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: cause.message }))
    );
    proc.on("close", (code) =>
      resolve(ok({ stdout, stderr, exitCode: code ?? 0 } satisfies GitOutput))
    );
  });

const spawned: string[][] = [];
const recordingGit: GitExec = (args, cwd, options) => {
  spawned.push(args);
  return systemGit(args, cwd, options);
};

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  }).trim();
}

let root: string;
let db: DB;
let bus: CommandBus;
let indexer: RepoIndexer;
let profileId: string;
let repoId: string;
let mergedWorktreeId: string;
let dirtyWorktreeId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-prune-handlers-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "Tester"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(repo, "a.txt"), "1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "baseline"]);

  // A finished branch: merged into main, its last commit long ago. Backdate
  // the committer date — `lastActivityAt` is `git log -1 --format=%cI`, and
  // the staleness rule reads it.
  git(repo, ["checkout", "-q", "-b", "feat/done"]);
  writeFileSync(join(repo, "done.txt"), "done\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "finished work"], {
    GIT_COMMITTER_DATE: OLD_COMMIT_DATE,
    GIT_AUTHOR_DATE: OLD_COMMIT_DATE
  });
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["merge", "--no-ff", "-m", "merge feat/done", "feat/done"]);

  await worktreeAdd(systemGit, repo, join(root, "wt-done"), "feat/done", {
    newBranch: false
  });
  await worktreeAdd(systemGit, repo, join(root, "wt-busy"), "feat/busy", {
    newBranch: true
  });
  // Uncommitted work in the second worktree: the sweep must never offer it.
  writeFileSync(join(root, "wt-busy", "a.txt"), "edited\n");
  // Ignored bulk plus a local secret, in the worktree the sweep will offer.
  mkdirSync(join(root, "wt-done", "node_modules", "left-pad"), {
    recursive: true
  });
  writeFileSync(
    join(root, "wt-done", "node_modules", "left-pad", "index.js"),
    "x".repeat(2048)
  );
  writeFileSync(join(root, "wt-done", ".env"), "SECRET=hunter2\n");

  db = openDatabase(":memory:");
  profileId = new ProfileService(db).create({ name: "T", email: "t@t.com" }).id;
  indexer = new RepoIndexer(db, systemGit);
  const added = await indexer.indexRepoAt(profileId, repo);
  if (!added.ok) throw new Error("index failed");
  repoId = added.value.id;
  await indexer.refreshRepoWorktrees(repoId);
  const worktrees = indexer.getRepo(repoId)?.worktrees ?? [];
  mergedWorktreeId =
    worktrees.find((worktree) => worktree.branch === "feat/done")?.id ?? "";
  dirtyWorktreeId =
    worktrees.find((worktree) => worktree.branch === "feat/busy")?.id ?? "";
  expect(mergedWorktreeId).not.toBe("");
  expect(dirtyWorktreeId).not.toBe("");

  const state = new WorktreeStateService(db, recordingGit);
  const operations = new WorktreeOperationQueue();
  bus = new CommandBus();
  registerPruneHandlers(
    bus,
    db,
    recordingGit,
    indexer,
    createWorktreeRefresher(state, db),
    operations
  );
});

afterAll(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("prune:scan", () => {
  it("finds the merged worktree on a profile nobody has browsed", async () => {
    // The premise: indexing does not compute per-worktree Git state, so the
    // Stale lens has nothing to filter here. Prove that first, or this test
    // does not show what it claims.
    const beforeSweep = indexer
      .getRepo(repoId)
      ?.worktrees.find((worktree) => worktree.id === mergedWorktreeId);
    expect(beforeSweep?.mergedIntoDefault).toBe(false);
    expect(beforeSweep?.lastActivityAt).toBeUndefined();

    const result = await bus.dispatch("prune:scan", {
      operationId: "sweep-1",
      profileId
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancelled).toBe(false);
    expect(result.value.counts.repos.scanned).toBe(1);
    const candidates = result.value.results.flatMap((repo) => repo.candidates);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      worktreeId: mergedWorktreeId,
      branch: "feat/done",
      reason: { kind: "merged_into_default", defaultBranch: "main" }
    });
    // Sized during the sweep's second phase, from the real directory.
    expect(candidates[0]?.sizeBytes).toBeGreaterThan(2000);
    expect(result.value.counts.sizeBytes).toBe(candidates[0]?.sizeBytes);
  });

  it("never offers the dirty worktree", async () => {
    const result = await bus.dispatch("prune:scan", {
      operationId: "sweep-dirty",
      profileId,
      force: true
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.results
      .flatMap((repo) => repo.candidates)
      .map((candidate) => candidate.worktreeId);
    expect(ids).not.toContain(dirtyWorktreeId);
  });

  it("reuses the states it computed, so a second sweep spawns no probes", async () => {
    // This is the resumability claim: a cancelled sweep is not wasted work,
    // because everything it computed is cached in `worktree_state`.
    spawned.length = 0;
    const result = await bus.dispatch("prune:scan", {
      operationId: "sweep-2",
      profileId
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts.repos.cached).toBe(1);
    expect(result.value.counts.repos.scanned).toBe(0);
    expect(spawned).toEqual([]);
    // And it still answers.
    expect(result.value.counts.candidates).toBe(1);
  });

  it("re-reads everything when forced", async () => {
    spawned.length = 0;
    const result = await bus.dispatch("prune:scan", {
      operationId: "sweep-3",
      profileId,
      force: true
    });
    expect(result.ok && result.value.counts.repos.scanned).toBe(1);
    expect(spawned.some((args) => args[0] === "status")).toBe(true);
  });

  it("refuses a blank operation id and an unknown profile", async () => {
    const blank = await bus.dispatch("prune:scan", {
      operationId: "  ",
      profileId
    });
    expect(blank.ok).toBe(false);
    const unknown = await bus.dispatch("prune:scan", {
      operationId: "sweep-4",
      profileId: "nope"
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("not_found");
  });

  it("refuses a second sweep under the same operation id", async () => {
    const first = bus.dispatch("prune:scan", {
      operationId: "sweep-dup",
      profileId,
      force: true
    });
    const second = await bus.dispatch("prune:scan", {
      operationId: "sweep-dup",
      profileId
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("operation_in_progress");
    await first;
  });

  it("reports a cancel for a live sweep and not for an unknown one", async () => {
    const running = bus.dispatch("prune:scan", {
      operationId: "sweep-cancel",
      profileId,
      force: true
    });
    const cancelled = await bus.dispatch("prune:cancelScan", {
      operationId: "sweep-cancel"
    });
    expect(cancelled.ok && cancelled.value.cancelled).toBe(true);
    await running;
    const stale = await bus.dispatch("prune:cancelScan", {
      operationId: "sweep-cancel"
    });
    expect(stale.ok && stale.value.cancelled).toBe(false);
  });
});

describe("prune:reclaimPreview", () => {
  it("reports what git would delete, sparing the default patterns", async () => {
    const result = await bus.dispatch("prune:reclaimPreview", {
      worktreeId: mergedWorktreeId
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBe("feat/done");
    expect(result.value.entries.map((entry) => entry.path)).toEqual([
      "node_modules/"
    ]);
    expect(result.value.excludes).toEqual([...RECLAIM_DEFAULT_EXCLUDES]);
    expect(existsSync(join(root, "wt-done", "node_modules"))).toBe(true);
  });

  it("refuses an unknown worktree", async () => {
    const result = await bus.dispatch("prune:reclaimPreview", {
      worktreeId: "nope"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("refuses a worktree whose checkout is gone", async () => {
    db.prepare("UPDATE worktrees SET missing = 1 WHERE id = ?").run(
      dirtyWorktreeId
    );
    try {
      const result = await bus.dispatch("prune:reclaimPreview", {
        worktreeId: dirtyWorktreeId
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("worktree_missing");
    } finally {
      db.prepare("UPDATE worktrees SET missing = 0 WHERE id = ?").run(
        dirtyWorktreeId
      );
    }
  });
});

describe("prune:reclaim", () => {
  it("deletes the ignored bulk, keeps the secret, and keeps the worktree", async () => {
    const result = await bus.dispatch("prune:reclaim", {
      operationId: "reclaim-1",
      worktreeIds: [mergedWorktreeId]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts.worktrees.reclaimed).toBe(1);
    expect(result.value.counts.freedBytes).toBeGreaterThan(2000);
    expect(result.value.results[0]).toMatchObject({
      outcome: "reclaimed",
      branch: "feat/done",
      plannedPaths: 1
    });

    expect(existsSync(join(root, "wt-done", "node_modules"))).toBe(false);
    // Spared by `.env*`, and the checkout itself is untouched.
    expect(existsSync(join(root, "wt-done", ".env"))).toBe(true);
    expect(existsSync(join(root, "wt-done", "done.txt"))).toBe(true);
    expect(existsSync(join(root, "wt-done", ".git"))).toBe(true);
  });

  it("reports a second pass as nothing to reclaim", async () => {
    const result = await bus.dispatch("prune:reclaim", {
      operationId: "reclaim-2",
      worktreeIds: [mergedWorktreeId]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts.worktrees.nothing_to_reclaim).toBe(1);
    expect(result.value.counts.freedBytes).toBe(0);
  });

  it("skips a gone checkout rather than failing the batch", async () => {
    db.prepare("UPDATE worktrees SET missing = 1 WHERE id = ?").run(
      dirtyWorktreeId
    );
    try {
      const result = await bus.dispatch("prune:reclaim", {
        operationId: "reclaim-3",
        worktreeIds: [dirtyWorktreeId, mergedWorktreeId]
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results[0]).toMatchObject({
        outcome: "skipped",
        reason: "worktree_missing"
      });
      expect(result.value.results[1]?.outcome).toBe("nothing_to_reclaim");
    } finally {
      db.prepare("UPDATE worktrees SET missing = 0 WHERE id = ?").run(
        dirtyWorktreeId
      );
    }
  });

  it("records an unknown worktree as a failure without stopping", async () => {
    const result = await bus.dispatch("prune:reclaim", {
      operationId: "reclaim-4",
      worktreeIds: ["nope", mergedWorktreeId]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results[0]?.outcome).toBe("failed");
    expect(result.value.results[1]?.outcome).toBe("nothing_to_reclaim");
  });

  it("cancels the rest of the batch when asked", async () => {
    const cancelled = await bus.dispatch("prune:cancelReclaim", {
      operationId: "reclaim-live"
    });
    expect(cancelled.ok && cancelled.value.cancelled).toBe(false);
  });
});
