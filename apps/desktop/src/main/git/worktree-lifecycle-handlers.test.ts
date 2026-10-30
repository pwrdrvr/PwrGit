import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { SettingsService } from "../settings/settings-service";
import type { GitExec } from "./dugite";
import { worktreeAdd } from "./git-service";
import { RepoIndexer } from "./repo-indexer";
import { registerWorktreeLifecycleHandlers } from "./worktree-lifecycle-handlers";
import { WorktreeStateService } from "./worktree-state";
import { createSystemGit } from "./test-support/system-git";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

// The handlers spawn git through dugite's execGit and broadcast over Electron
// IPC; neither exists under vitest. Route execGit through the test's recording
// system-git exec and stub the event emitter.
const hoisted = vi.hoisted(() => ({
  execGit: null as unknown as (args: string[], cwd: string) => Promise<unknown>,
  /** Swapped per test to make a folder deletion fail; null = the real one. */
  deleteTree: null as null | ((path: string) => Promise<never>)
}));

vi.mock("../ipc", () => ({
  registerIpc: vi.fn(),
  emitEvent: vi.fn()
}));

vi.mock("../logs", () => ({ logMain: vi.fn() }));

vi.mock("../util/delete-tree", async (importActual) => {
  const actual = await importActual<typeof import("../util/delete-tree")>();
  return {
    ...actual,
    deleteTree: (...args: Parameters<typeof actual.deleteTree>) =>
      hoisted.deleteTree === null
        ? actual.deleteTree(...args)
        : hoisted.deleteTree(args[0])
  };
});

vi.mock("./dugite", async (importActual) => {
  const actual = await importActual<typeof import("./dugite")>();
  return {
    ...actual,
    execGit: (args: string[], cwd: string) => hoisted.execGit(args, cwd)
  };
});

const systemGit: GitExec = createSystemGit();

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

  const operations = new WorktreeOperationQueue();
  state = new WorktreeStateService(db, recordingGit, operations);
  bus = new CommandBus();
  const settings = new SettingsService(join(root, "settings.json"));
  // `worktree:create` resolves its own path from settings — point it inside the
  // sandbox, or the default (~/wt) makes the test write to the real home.
  settings.update({ worktreeRoot: join(root, "wt") });
  registerWorktreeLifecycleHandlers(bus, db, indexer, settings, state, operations);
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
  /** Add a worktree on a new branch and index it; returns the sidebar row. */
  async function addIndexedWorktree(
    branch: string
  ): Promise<{ id: string; path: string }> {
    const path = join(root, `wt-${branch}`);
    await worktreeAdd(systemGit, repoPath, path, branch, { newBranch: true });
    await indexer.refreshRepoWorktrees(repoId);
    const wt = indexer
      .listRepos(profileId)[0]
      ?.worktrees.find((w) => w.branch === branch);
    if (wt === undefined) throw new Error("worktree not indexed");
    return { id: wt.id, path };
  }
  const rowExists = (id: string): boolean =>
    indexer.listRepos(profileId)[0]?.worktrees.some((w) => w.id === id) ??
    false;
  // Windows can hold a fresh checkout open (antivirus, our own probes) for a
  // moment; retry like the production path does.
  const rmRetrying = (path: string): void =>
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 15,
      retryDelay: 300
    });

  // Another tool (Codex, a shell `rm -rf` plus `git worktree prune`) can
  // delete a checkout and unregister it before PwrGit re-indexes. The row
  // lingers in the sidebar with nothing behind it: fetch fails ("cannot change
  // to …"), and remove used to fail too ("is not a working tree"), leaving no
  // way to get rid of it. Removal must succeed and drop the row.
  it("removes a worktree whose directory is gone and metadata already pruned", async () => {
    const wt = await addIndexedWorktree("pruned");
    rmRetrying(wt.path);
    git(repoPath, ["worktree", "prune"]);

    const res = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.removed).toEqual([wt.id]);
      expect(res.value.failed).toEqual([]);
    }
    expect(rowExists(wt.id)).toBe(false);
    expect(vi.mocked(emitEvent)).toHaveBeenCalledWith("worktree:removed", {
      worktreeId: wt.id
    });
  });

  // Same staleness, but the directory is still there and git disowns it. The
  // row is a fossil either way, so it must go — but the directory stays and
  // the failure names it, since nothing proves it is safe to delete. It is
  // reported as a failure only: `worktree:removed` would tick the renderer's
  // removal progress for something that was not removed.
  it("drops the row but keeps a directory git no longer recognises", async () => {
    const wt = await addIndexedWorktree("orphan");
    // Unregister without deleting: drop the .git link, prune the metadata.
    rmRetrying(join(wt.path, ".git"));
    git(repoPath, ["worktree", "prune"]);
    vi.mocked(emitEvent).mockClear();

    const res = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.removed).toEqual([]);
      expect(res.value.failed).toHaveLength(1);
      expect(res.value.failed[0]?.message).toMatch(/no longer registered/i);
    }
    expect(existsSync(wt.path)).toBe(true);
    expect(rowExists(wt.id)).toBe(false);
    expect(vi.mocked(emitEvent)).not.toHaveBeenCalledWith("worktree:removed", {
      worktreeId: wt.id
    });
    expect(vi.mocked(emitEvent)).toHaveBeenCalledWith("repo:changed", {
      profileId
    });
  });

  // The deleted-but-NOT-pruned case: git still lists the entry (`prunable`),
  // the state probe flags the row missing, and every other action refuses.
  // The next re-index drops such a row by itself, but until it runs (and for
  // ones it keeps: locked, on a detached volume) Remove is the way out — git
  // removes a prunable entry without complaint, and the probe lock it takes
  // must not spawn git in the deleted directory either.
  it("removes a worktree the index has flagged missing", async () => {
    const wt = await addIndexedWorktree("gone");
    rmRetrying(wt.path);
    await state.compute(wt.id);
    expect(
      indexer.listRepos(profileId)[0]?.worktrees.find((w) => w.id === wt.id)
    ).toMatchObject({ missing: true });

    const res = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ removed: [wt.id], dirty: [], failed: [] });
    }
    expect(rowExists(wt.id)).toBe(false);
    expect(vi.mocked(emitEvent)).toHaveBeenCalledWith("worktree:removed", {
      worktreeId: wt.id
    });
  });
});

/** Every logMain call, flattened to one string per call for matching. */
const logged = (level: string): string[] =>
  vi
    .mocked(logMain)
    .mock.calls.filter((call) => call[0] === level)
    .map((call) => call.slice(1).map(String).join(" "));

/** Make every directory under `dir` (and `dir`) writable again, for cleanup. */
function unlockTree(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockTree(join(dir, entry.name));
  }
}

describe("worktree:removeMany × what it deletes and what it reports", () => {
  async function addIndexedWorktree(
    branch: string
  ): Promise<{ id: string; path: string }> {
    const path = join(root, `wt-${branch}`);
    await worktreeAdd(systemGit, repoPath, path, branch, { newBranch: true });
    await indexer.refreshRepoWorktrees(repoId);
    const wt = indexer
      .listRepos(profileId)[0]
      ?.worktrees.find((w) => w.branch === branch);
    if (wt === undefined) throw new Error("worktree not indexed");
    return { id: wt.id, path: wt.path };
  }
  const rowExists = (id: string): boolean =>
    indexer.listRepos(profileId)[0]?.worktrees.some((w) => w.id === id) ??
    false;
  const registered = (path: string): boolean =>
    execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf8"
    })
      .split(/\r?\n/)
      .includes(`worktree ${path}`);

  // The 2026-10-16 beachball. Go writes its module cache read-only (0555
  // directories), and a worktree that ran `go` with GOPATH inside it holds
  // one, ignored. `git worktree remove` deleted half of it, hit "Permission
  // denied", unregistered the worktree anyway, and the fallback rmSync then
  // blocked the main process for ~34s retrying a delete it could never
  // finish. Removal has to finish the job, and never stall the event loop.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "removes a worktree holding a read-only module cache without stalling the app",
    async () => {
      writeFileSync(join(repoPath, ".git", "info", "exclude"), ".local/\n");
      const wt = await addIndexedWorktree("gocache");
      const mod = join(wt.path, ".local", "go", "pkg", "mod", "example.com");
      const dirs: string[] = [];
      for (let m = 0; m < 6; m += 1) {
        const dir = join(mod, `mod${m}@v1.0.0`, "internal");
        mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 60; f += 1) {
          writeFileSync(join(dir, `f${f}.go`), "package internal\n");
        }
        dirs.push(dir, join(dir, ".."));
      }
      // Deepest first, the way Go leaves them.
      for (const dir of dirs) chmodSync(dir, 0o555);
      vi.mocked(emitEvent).mockClear();
      vi.mocked(logMain).mockClear();

      let last = performance.now();
      let worstGap = 0;
      const ticker = setInterval(() => {
        const now = performance.now();
        worstGap = Math.max(worstGap, now - last);
        last = now;
      }, 10);
      try {
        const res = await bus.dispatch("worktree:removeMany", {
          worktreeIds: [wt.id]
        });
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value).toEqual({ removed: [wt.id], dirty: [], failed: [] });
        }
        expect(existsSync(wt.path)).toBe(false);
        expect(registered(wt.path)).toBe(false);
        expect(rowExists(wt.id)).toBe(false);
        // A synchronous delete shows up here as one enormous gap.
        expect(worstGap).toBeLessThan(1_000);
        // Progress is streamed so the dialog can show the delete moving.
        expect(vi.mocked(emitEvent)).toHaveBeenCalledWith(
          "worktree:removeProgress",
          expect.objectContaining({ worktreeId: wt.id })
        );
        const progress = vi
          .mocked(emitEvent)
          .mock.calls.filter(([name]) => name === "worktree:removeProgress")
          .map(([, payload]) => (payload as { itemsDeleted: number }).itemsDeleted);
        expect(Math.max(...progress)).toBeGreaterThanOrEqual(6 * 60);
      } finally {
        clearInterval(ticker);
        unlockTree(wt.path);
        rmSync(join(repoPath, ".git", "info", "exclude"), { force: true });
      }
    },
    90_000
  );

  // A delete that stops partway must not leave an unregistered folder nobody
  // can see — the 20 MB the user was left with. The worktree stays in Git
  // and in the sidebar, the reason names the file that stopped it, and the
  // failure reaches the log, where the old path wrote nothing at all.
  it("keeps a worktree it could not delete registered, and logs why", async () => {
    const wt = await addIndexedWorktree("stuck");
    const { DeleteTreeError } = await import("../util/delete-tree");
    hoisted.deleteTree = async (path) => {
      const cause = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES"
      });
      throw new DeleteTreeError(path, join(path, "cache", "locked"), cause, 12);
    };
    vi.mocked(emitEvent).mockClear();
    vi.mocked(logMain).mockClear();
    try {
      const res = await bus.dispatch("worktree:removeMany", {
        worktreeIds: [wt.id]
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.removed).toEqual([]);
      expect(res.value.failed).toHaveLength(1);
      const message = res.value.failed[0]?.message ?? "";
      expect(message).toMatch(/permission denied/i);
      expect(message).toContain(join("cache", "locked"));
      expect(existsSync(wt.path)).toBe(true);
      expect(registered(wt.path)).toBe(true);
      expect(rowExists(wt.id)).toBe(true);
      expect(vi.mocked(emitEvent)).not.toHaveBeenCalledWith("worktree:removed", {
        worktreeId: wt.id
      });
      expect(logged("error").some((line) => line.includes(wt.path))).toBe(true);
    } finally {
      hoisted.deleteTree = null;
    }
  });

  it("logs a folder Git no longer recognises", async () => {
    const wt = await addIndexedWorktree("disowned");
    rmSync(join(wt.path, ".git"), { force: true });
    git(repoPath, ["worktree", "prune"]);
    vi.mocked(logMain).mockClear();

    const res = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.failed).toHaveLength(1);
    expect(logged("error").some((line) => line.includes(wt.path))).toBe(true);
  });

  // Declining "Remove anyway" is a choice, not a failure — but the log should
  // still say which worktrees were kept and why.
  it("deletes nothing from a worktree with uncommitted changes, and logs the skip", async () => {
    const wt = await addIndexedWorktree("dirty");
    writeFileSync(join(wt.path, "scratch.txt"), "unsaved\n");
    vi.mocked(logMain).mockClear();

    const res = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id]
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ removed: [], dirty: [wt.id], failed: [] });
    expect(existsSync(join(wt.path, "scratch.txt"))).toBe(true);
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(logged("warn").some((line) => line.includes(wt.path))).toBe(true);

    const forced = await bus.dispatch("worktree:removeMany", {
      worktreeIds: [wt.id],
      force: true
    });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.value.removed).toEqual([wt.id]);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("refuses a locked worktree before deleting anything", async () => {
    const wt = await addIndexedWorktree("locked");
    git(repoPath, ["worktree", "lock", wt.path]);
    try {
      const res = await bus.dispatch("worktree:removeMany", {
        worktreeIds: [wt.id],
        force: true
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.removed).toEqual([]);
        expect(res.value.failed[0]?.message).toMatch(/locked/i);
      }
      expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
      expect(registered(wt.path)).toBe(true);
    } finally {
      git(repoPath, ["worktree", "unlock", wt.path]);
    }
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
