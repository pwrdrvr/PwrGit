import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { SettingsService } from "../settings/settings-service";
import type { GitExec, GitOutput } from "./dugite";
import { worktreeAdd } from "./git-service";
import { RepoIndexer } from "./repo-indexer";
import { registerWorktreeLifecycleHandlers } from "./worktree-lifecycle-handlers";
import { WorktreeStateService } from "./worktree-state";

// The handlers spawn git through dugite's execGit and broadcast over Electron
// IPC; neither exists under vitest. Route execGit through the test's recording
// system-git exec and stub the event emitter.
const hoisted = vi.hoisted(() => ({
  execGit: null as unknown as (args: string[], cwd: string) => Promise<unknown>
}));

vi.mock("../ipc", () => ({
  registerIpc: vi.fn(),
  emitEvent: vi.fn()
}));

vi.mock("./dugite", async (importActual) => {
  const actual = await importActual<typeof import("./dugite")>();
  return {
    ...actual,
    execGit: (args: string[], cwd: string) => hoisted.execGit(args, cwd)
  };
});

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

type GitCall = { args: string[]; cwd: string; start: number; end: number };
const calls: GitCall[] = [];
let seq = 0;
/** When set, `git status` (the probe's first command) parks until it opens. */
let statusGate: Promise<void> | null = null;

const recordingGit: GitExec = async (args, cwd) => {
  const call: GitCall = { args, cwd, start: (seq += 1), end: 0 };
  calls.push(call);
  if (args[0] === "status" && statusGate !== null) await statusGate;
  const out = await systemGit(args, cwd);
  call.end = seq += 1;
  return out;
};

hoisted.execGit = recordingGit;

const isRemove = (c: GitCall): boolean =>
  c.args[0] === "worktree" && c.args[1] === "remove";

let root: string;
let db: DB;
let bus: CommandBus;
let indexer: RepoIndexer;
let state: WorktreeStateService;
let profileId: string;
let repoId: string;
let repoPath: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-wtlock-"));
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

  state = new WorktreeStateService(db, recordingGit);
  bus = new CommandBus();
  const settings = new SettingsService(join(root, "settings.json"));
  // `worktree:create` resolves its own path from settings — point it inside the
  // sandbox, or the default (~/wt) makes the test write to the real home.
  settings.update({ worktreeRoot: join(root, "wt") });
  registerWorktreeLifecycleHandlers(bus, db, indexer, settings, state);
});

describe("worktree:removeMany × state probes", () => {
  // The Windows race: a probe's git chain has its cwd inside the worktree,
  // and Windows can't delete a directory that is any process's cwd. The
  // handler must drain in-flight probes before `git worktree remove` runs.
  it("waits for the in-flight probe, then removes; later probes are dropped", async () => {
    await worktreeAdd(systemGit, repoPath, join(root, "wt-race"), "race", {
      newBranch: true
    });
    await indexer.refreshRepoWorktrees(repoId);
    const wt = indexer
      .listRepos(profileId)[0]
      ?.worktrees.find((w) => w.branch === "race");
    if (wt === undefined) throw new Error("worktree not indexed");

    let openGate!: () => void;
    statusGate = new Promise<void>((r) => {
      openGate = r;
    });
    const probe = state.compute(wt.id);

    const removal = bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });
    await new Promise((r) => setTimeout(r, 50));
    // Still draining the parked probe — remove must not have spawned.
    expect(calls.some(isRemove)).toBe(false);

    openGate();
    statusGate = null;
    const res = await removal;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.removed).toEqual([wt.id]);
    expect(await probe).not.toBeNull();
    expect(existsSync(wt.path)).toBe(false);
    expect(vi.mocked(emitEvent)).toHaveBeenCalledWith("worktree:removed", {
      worktreeId: wt.id
    });

    // Every probe command in the worktree finished before remove began.
    const remove = calls.find(isRemove);
    const probeCalls = calls.filter((c) => c.cwd === wt.path);
    expect(remove).toBeDefined();
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const c of probeCalls) {
      expect(c.end).toBeGreaterThan(0);
      expect(c.end).toBeLessThan(remove?.start ?? 0);
    }
  });
});

describe("worktree:removeMany × pruned worktree", () => {
  // Another tool (Codex, a shell `rm -rf` plus `git worktree prune`) can
  // delete a checkout and unregister it before PwrGit re-indexes. The row
  // lingers in the sidebar with nothing behind it: fetch fails ("cannot change
  // to …"), and remove used to fail too ("is not a working tree"), leaving no
  // way to get rid of it. Removal must succeed and drop the row.
  it("removes a worktree whose directory is gone and metadata already pruned", async () => {
    const wtPath = join(root, "wt-pruned");
    await worktreeAdd(systemGit, repoPath, wtPath, "pruned", {
      newBranch: true
    });
    await indexer.refreshRepoWorktrees(repoId);
    const wt = indexer
      .listRepos(profileId)[0]
      ?.worktrees.find((w) => w.branch === "pruned");
    if (wt === undefined) throw new Error("worktree not indexed");

    rmSync(wtPath, { recursive: true, force: true });
    git(repoPath, ["worktree", "prune"]);

    const res = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.removed).toEqual([wt.id]);
      expect(res.value.failed).toEqual([]);
    }
    expect(
      indexer
        .listRepos(profileId)[0]
        ?.worktrees.some((w) => w.id === wt.id)
    ).toBe(false);
    expect(vi.mocked(emitEvent)).toHaveBeenCalledWith("worktree:removed", {
      worktreeId: wt.id
    });
  });

  // Same staleness, but the directory is still there and git disowns it. The
  // row is a fossil either way, so it must go — but the directory stays and
  // the failure names it, since nothing proves it is safe to delete.
  it("drops the row but keeps a directory git no longer recognises", async () => {
    const wtPath = join(root, "wt-orphan");
    await worktreeAdd(systemGit, repoPath, wtPath, "orphan", {
      newBranch: true
    });
    await indexer.refreshRepoWorktrees(repoId);
    const wt = indexer
      .listRepos(profileId)[0]
      ?.worktrees.find((w) => w.branch === "orphan");
    if (wt === undefined) throw new Error("worktree not indexed");

    // Unregister without deleting: drop the .git link, prune the metadata.
    rmSync(join(wtPath, ".git"), { force: true });
    git(repoPath, ["worktree", "prune"]);

    const res = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.removed).toEqual([]);
      expect(res.value.failed).toHaveLength(1);
      expect(res.value.failed[0]?.message).toMatch(/no longer registered/i);
    }
    expect(existsSync(wtPath)).toBe(true);
    expect(
      indexer
        .listRepos(profileId)[0]
        ?.worktrees.some((w) => w.id === wt.id)
    ).toBe(false);
  });
});

describe("worktree:create", () => {
  // The renderer selects the worktree it just made. Without an id in the reply
  // it can only guess, and a fresh branch lands unfound in a repo with a
  // hundred worktrees.
  it("reports the id of the worktree it indexed", async () => {
    const res = await bus.dispatch("worktree:create", {
      repoId,
      branch: "feature/created",
      newBranch: true
    });

    expect(res.ok).toBe(true);
    const indexed = indexer
      .listRepos(profileId)[0]
      ?.worktrees.find((w) => w.branch === "feature/created");
    expect(indexed).toBeDefined();
    if (res.ok) expect(res.value.worktreeId).toBe(indexed?.id);
  });

  // The flow this reply exists for: a ⌘K pick on a remote-only branch runs
  // `worktree add -b <branch> <path> <startPoint>`, where the start point is a
  // differently-named ref. The id has to come from the branch that `-b` made,
  // not from anything derived off the ref it started at.
  it("reports the id when branching from a remote-tracking ref", async () => {
    git(repoPath, [
      "update-ref",
      "refs/remotes/origin/claude/thread-link",
      "HEAD"
    ]);

    const res = await bus.dispatch("worktree:create", {
      repoId,
      branch: "claude/thread-link",
      newBranch: true,
      startPoint: "refs/remotes/origin/claude/thread-link"
    });

    expect(res.ok).toBe(true);
    const indexed = indexer
      .listRepos(profileId)[0]
      ?.worktrees.find((w) => w.branch === "claude/thread-link");
    expect(indexed).toBeDefined();
    if (res.ok) expect(res.value.worktreeId).toBe(indexed?.id);
  });
});
