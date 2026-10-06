import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canPushCheckout,
  checkoutVerdict,
  removalStatus,
  type RemovalDecisions,
  type RemovalStep,
  type RepoRemovalReview
} from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec } from "./dugite";
import { trashIntoDirectory } from "./repo-removal-handlers";
import { RepoIndexer } from "./repo-indexer";
import {
  executeRepoRemoval,
  parseRemovalStatus,
  reviewRepoRemoval,
  type RemovalExecuteDeps
} from "./repo-removal";
import { createSystemGit } from "./test-support/system-git";

const systemGit: GitExec = createSystemGit();

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commit(dir: string, file: string, body: string, message: string): void {
  writeFileSync(join(dir, file), body);
  git(dir, ["add", file]);
  git(dir, ["commit", "-q", "-m", message]);
}

type Fixture = {
  root: string;
  repo: string;
  trashDir: string;
  db: DB;
  indexer: RepoIndexer;
  repoId: string;
  wt: (name: string) => string;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A repository named harbor-api with a bare origin, `main` pushed, and the
 * linked worktrees `setup` asks for. The primary checkout lives under
 * `<root>/harbor-api`, worktrees under `<root>/wt-<name>`.
 */
async function fixture(setup: (f: { repo: string; root: string }) => void = () => {}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-repo-removal-")));
  roots.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "harbor-api");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "Tester"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  commit(repo, "a.txt", "1\n", "baseline");
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  setup({ repo, root });

  const db = openDatabase(":memory:");
  const profileId = new ProfileService(db).create({ name: "Work", email: "t@t.com" }).id;
  const indexer = new RepoIndexer(db, systemGit);
  const added = await indexer.indexRepoAt(profileId, repo);
  if (!added.ok) throw new Error(added.error.message);
  await indexer.refreshRepoWorktrees(added.value.id);
  return {
    root,
    repo,
    trashDir: join(root, "trash"),
    db,
    indexer,
    repoId: added.value.id,
    wt: (name) => join(root, `wt-${name}`)
  };
}

/** A linked worktree on a new branch, pushed with an upstream. */
function pushedWorktree(repo: string, root: string, name: string): string {
  const path = join(root, `wt-${name}`);
  git(repo, ["worktree", "add", "-q", "-b", `feat/${name}`, path]);
  commit(path, `${name}.txt`, `${name}\n`, `work on ${name}`);
  git(path, ["push", "-q", "-u", "origin", `feat/${name}`]);
  return path;
}

async function review(f: Fixture): Promise<RepoRemovalReview> {
  const result = await reviewRepoRemoval(
    { db: f.db, git: systemGit, measure: async () => ({ bytes: 10, entries: 1, partial: false, inaccessible: 0, hardLinks: 0 }) },
    f.repoId
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function executeDeps(f: Fixture, overrides: Partial<RemovalExecuteDeps> = {}) {
  const progress: RemovalStep[][] = [];
  const trashed: string[] = [];
  const trashInto = trashIntoDirectory(f.trashDir);
  const deps: RemovalExecuteDeps = {
    db: f.db,
    git: systemGit,
    trash: async (path) => {
      trashed.push(path);
      await trashInto(path);
    },
    lockForRemoval: async () => () => {},
    runWorktree: (_id, op) => op(),
    runRepository: (_id, op) => op(),
    refreshRepo: async (repoId) => {
      await f.indexer.refreshRepoWorktrees(repoId);
    },
    deleteRepo: (repoId) => f.indexer.deleteRepo(repoId),
    onProgress: (steps) => progress.push(steps),
    ...overrides
  };
  return { deps, progress, trashed };
}

const byBranch = (r: RepoRemovalReview, branch: string) => {
  const found = r.checkouts.find((c) => c.branch === branch);
  if (found === undefined) throw new Error(`no checkout on ${branch}`);
  return found;
};

describe("parseRemovalStatus", () => {
  it("counts each kind of entry and reads the branch headers", () => {
    const parsed = parseRemovalStatus(
      [
        "# branch.oid 1234567890abcdef",
        "# branch.head feat/x",
        "# branch.upstream origin/feat/x",
        "# branch.ab +1 -0",
        "1 .M N... 100644 100644 100644 aaa aaa a.txt",
        "2 R. N... 100644 100644 100644 aaa aaa R100 b.txt\ta.txt",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc c.txt",
        "? new.txt",
        "? other.txt",
        ""
      ].join("\n")
    );
    expect(parsed).toEqual({
      head: "1234567890abcdef",
      branch: "feat/x",
      upstream: "origin/feat/x",
      uncommitted: 2,
      untracked: 2,
      conflicted: 1
    });
    expect(parseRemovalStatus("# branch.head (detached)\n").branch).toBe("");
  });
});

describe("reviewRepoRemoval", () => {
  it("calls a pushed, clean repository safe end to end", async () => {
    const f = await fixture(({ repo, root }) => pushedWorktree(repo, root, "done"));
    const r = await review(f);
    expect(r.name).toBe("harbor-api");
    expect(r.remotes).toEqual([{ name: "origin", url: join(f.root, "origin.git") }]);
    // Worktrees first, the main checkout last: the removal order.
    expect(r.checkouts.map((c) => [c.branch, c.isPrimary])).toEqual([
      ["feat/done", false],
      ["main", true]
    ]);
    expect(r.checkouts.every((c) => checkoutVerdict(c) === "safe")).toBe(true);
    expect(r.stashes.count).toBe(0);
    expect(r.branches).toEqual([]);
    const status = removalStatus(r, { checkouts: {}, branches: {} });
    expect(status).toMatchObject({
      ready: true,
      removePrimary: true,
      partial: false,
      needsName: false,
      folderCount: 2,
      bytes: 20
    });
  });

  it("finds every kind of work the removal would lose", async () => {
    const f = await fixture(({ repo, root }) => {
      // Uncommitted and untracked files on a pushed branch.
      const dirty = pushedWorktree(repo, root, "dirty");
      writeFileSync(join(dirty, "a.txt"), "edited\n");
      writeFileSync(join(dirty, "scratch.txt"), "notes\n");
      // Two commits on a branch that was never pushed: the only risk.
      const ahead = join(root, "wt-ahead");
      git(repo, ["worktree", "add", "-q", "-b", "feat/ahead", ahead]);
      commit(ahead, "x.txt", "1\n", "one");
      commit(ahead, "x.txt", "2\n", "two");
      // A detached HEAD on a commit no remote has.
      const detached = join(root, "wt-detached");
      git(repo, ["worktree", "add", "-q", "--detach", detached]);
      commit(detached, "d.txt", "d\n", "detached work");
      // A stash and a branch nothing has checked out, both in the shared .git.
      writeFileSync(join(repo, "a.txt"), "stashed\n");
      git(repo, ["stash", "push", "-q", "-m", "wip harbor"]);
      git(repo, ["branch", "spike/loose"]);
      git(repo, ["checkout", "-q", "spike/loose"]);
      commit(repo, "s.txt", "s\n", "loose work");
      git(repo, ["checkout", "-q", "main"]);
      // A local branch with nothing unpushed is not worth asking about.
      git(repo, ["branch", "old/even"]);
    });
    const r = await review(f);

    const dirty = byBranch(r, "feat/dirty");
    expect(dirty).toMatchObject({ uncommitted: 1, untracked: 1, unpushed: 0 });
    expect(checkoutVerdict(dirty)).toBe("at_risk");
    expect(canPushCheckout(dirty)).toBe(false);

    const ahead = byBranch(r, "feat/ahead");
    expect(ahead).toMatchObject({ unpushed: 2, upstream: null, pushRemote: "origin" });
    expect(canPushCheckout(ahead)).toBe(true);

    const detached = byBranch(r, "");
    expect(detached.unpushed).toBe(1);
    expect(canPushCheckout(detached)).toBe(false);

    expect(checkoutVerdict(byBranch(r, "main"))).toBe("safe");
    expect(r.stashes).toMatchObject({ count: 1 });
    expect(r.stashes.newestSubject).toContain("wip harbor");
    expect(r.branches).toEqual([
      { name: "spike/loose", unpushed: 1, pushRemote: "origin" }
    ]);

    const status = removalStatus(r, { checkouts: {}, branches: {} });
    // Three checkouts, the stash and the loose branch.
    expect(status.undecided).toBe(5);
    expect(status.ready).toBe(false);
  });

  it("blocks a locked worktree and one stopped in a rebase, and flags a missing one", async () => {
    const f = await fixture(({ repo, root }) => {
      const locked = pushedWorktree(repo, root, "locked");
      git(repo, ["worktree", "lock", locked]);
      const rebasing = pushedWorktree(repo, root, "rebasing");
      commit(repo, "a.txt", "main side\n", "main edit");
      git(repo, ["push", "-q", "origin", "main"]);
      commit(rebasing, "a.txt", "branch side\n", "branch edit");
      try {
        git(rebasing, ["rebase", "main"]);
      } catch {
        // The conflict is the point: the rebase stops half way.
      }
      const gone = pushedWorktree(repo, root, "gone");
      rmSync(gone, { recursive: true, force: true });
    });
    const r = await review(f);
    expect(byBranch(r, "feat/locked")).toMatchObject({ locked: true });
    expect(checkoutVerdict(byBranch(r, "feat/locked"))).toBe("blocked");
    const rebasing = r.checkouts.find((c) => c.path === f.wt("rebasing"));
    expect(rebasing?.inProgress).toBe("rebase");
    expect(rebasing === undefined ? null : checkoutVerdict(rebasing)).toBe("blocked");
    const gone = byBranch(r, "feat/gone");
    expect(gone).toMatchObject({ missing: true, bytes: null });
    expect(checkoutVerdict(gone)).toBe("at_risk");
  });

  it("refuses a repository whose main checkout is gone", async () => {
    const f = await fixture();
    rmSync(f.repo, { recursive: true, force: true });
    const result = await reviewRepoRemoval({ db: f.db, git: systemGit }, f.repoId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("primary_missing");
  });
});

describe("executeRepoRemoval", () => {
  it("moves every worktree, then the main checkout, to the Trash and forgets the repository", async () => {
    const f = await fixture(({ repo, root }) => {
      pushedWorktree(repo, root, "one");
      pushedWorktree(repo, root, "two");
    });
    const { deps, trashed, progress } = executeDeps(f);
    const result = await executeRepoRemoval(deps, {
      repoId: f.repoId,
      decisions: { checkouts: {}, branches: {} }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("removed");
    expect(result.value.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    // Linked worktrees first (in Git's listing order), the folder holding
    // .git last.
    expect(trashed.at(-1)).toBe(f.repo);
    expect(trashed.slice(0, -1).sort()).toEqual([f.wt("one"), f.wt("two")]);
    expect(existsSync(f.repo)).toBe(false);
    expect(readdirSync(f.trashDir)).toHaveLength(3);
    expect(f.indexer.getRepo(f.repoId)).toBeNull();
    // Streamed: an initial all-pending list, then each transition.
    expect(progress[0]?.every((s) => s.status === "pending")).toBe(true);
    expect(progress.at(-1)?.every((s) => s.status === "done")).toBe(true);
  });

  it("keeps the main checkout when a worktree is kept, and clears only the removed records", async () => {
    const f = await fixture(({ repo, root }) => {
      pushedWorktree(repo, root, "done");
      const keep = pushedWorktree(repo, root, "keep");
      writeFileSync(join(keep, "a.txt"), "edited\n");
    });
    const r = await review(f);
    const keep = byBranch(r, "feat/keep");
    const decisions: RemovalDecisions = {
      checkouts: { [keep.worktreeId]: "keep" },
      branches: {}
    };
    expect(removalStatus(r, decisions)).toMatchObject({ partial: true, removePrimary: false });
    const { deps, trashed } = executeDeps(f);
    const result = await executeRepoRemoval(deps, { repoId: f.repoId, decisions });
    expect(result.ok && result.value.outcome).toBe("partial");
    expect(trashed).toEqual([f.wt("done")]);
    expect(existsSync(f.repo)).toBe(true);
    expect(existsSync(f.wt("keep"))).toBe(true);
    const listed = git(f.repo, ["worktree", "list", "--porcelain"]);
    expect(listed).not.toContain(f.wt("done"));
    expect(listed).toContain(f.wt("keep"));
    expect(f.indexer.getRepo(f.repoId)?.worktrees.map((w) => w.branch).sort()).toEqual([
      "feat/keep",
      "main"
    ]);
  });

  it("clears a missing worktree's record without touching the Trash", async () => {
    const f = await fixture(({ repo, root }) => {
      const gone = pushedWorktree(repo, root, "gone");
      rmSync(gone, { recursive: true, force: true });
      pushedWorktree(repo, root, "keep");
    });
    const r = await review(f);
    const decisions: RemovalDecisions = {
      checkouts: {
        [byBranch(r, "feat/gone").worktreeId]: "discard",
        [byBranch(r, "feat/keep").worktreeId]: "keep"
      },
      branches: {}
    };
    // Keeping a safe worktree is not an offered answer, so this is a full
    // removal that discards a record — and asks for the name.
    expect(removalStatus(r, decisions).needsName).toBe(true);
    const { deps, trashed } = executeDeps(f);
    const refused = await executeRepoRemoval(deps, { repoId: f.repoId, decisions });
    expect(!refused.ok && refused.error.code).toBe("confirm_name");
    expect(trashed).toEqual([]);

    const result = await executeRepoRemoval(deps, {
      repoId: f.repoId,
      decisions,
      confirmName: "harbor-api"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.find((s) => s.path === f.wt("gone"))?.kind).toBe("forget");
    expect(trashed).not.toContain(f.wt("gone"));
    expect(result.value.outcome).toBe("removed");
  });

  it("refuses when a checkout changed after the review", async () => {
    const f = await fixture(({ repo, root }) => pushedWorktree(repo, root, "done"));
    // Reviewed clean, so no answers were needed…
    const decisions: RemovalDecisions = { checkouts: {}, branches: {} };
    expect(removalStatus(await review(f), decisions).ready).toBe(true);
    // …and then someone kept working.
    writeFileSync(join(f.wt("done"), "late.txt"), "late\n");
    const { deps, trashed } = executeDeps(f);
    const result = await executeRepoRemoval(deps, { repoId: f.repoId, decisions });
    expect(!result.ok && result.error.code).toBe("review_changed");
    expect(trashed).toEqual([]);
    expect(existsSync(f.wt("done"))).toBe(true);
  });

  it("refuses a push choice: pushing is the renderer's, before removal", async () => {
    const f = await fixture(({ repo, root }) => {
      const ahead = join(root, "wt-ahead");
      git(repo, ["worktree", "add", "-q", "-b", "feat/ahead", ahead]);
      commit(ahead, "x.txt", "1\n", "one");
    });
    const r = await review(f);
    const { deps } = executeDeps(f);
    const result = await executeRepoRemoval(deps, {
      repoId: f.repoId,
      decisions: { checkouts: { [byBranch(r, "feat/ahead").worktreeId]: "push" }, branches: {} }
    });
    expect(!result.ok && result.error.code).toBe("review_changed");
  });

  it("stops before the main checkout when a worktree cannot be moved", async () => {
    const f = await fixture(({ repo, root }) => {
      pushedWorktree(repo, root, "stuck");
      pushedWorktree(repo, root, "fine");
    });
    const { deps, trashed } = executeDeps(f);
    const trash = deps.trash;
    deps.trash = async (path) => {
      if (path === f.wt("stuck")) throw new Error("Trash is not available on this volume");
      await trash(path);
    };
    const result = await executeRepoRemoval(deps, {
      repoId: f.repoId,
      decisions: { checkouts: {}, branches: {} }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("stopped");
    const status = Object.fromEntries(result.value.steps.map((s) => [s.path, s.status]));
    expect(status).toEqual({
      [f.wt("fine")]: "done",
      [f.wt("stuck")]: "failed",
      [f.repo]: "skipped"
    });
    expect(result.value.steps.at(-1)?.isPrimary).toBe(true);
    expect(result.value.steps.find((s) => s.status === "failed")?.message).toContain(
      "Trash is not available"
    );
    expect(trashed).toEqual([f.wt("fine")]);
    expect(existsSync(f.repo)).toBe(true);
    expect(existsSync(f.wt("stuck"))).toBe(true);
    expect(f.indexer.getRepo(f.repoId)?.worktrees.map((w) => w.branch).sort()).toEqual([
      "feat/stuck",
      "main"
    ]);
  });

  it("deletes outright only the folders named for it", async () => {
    const f = await fixture(({ repo, root }) => pushedWorktree(repo, root, "big"));
    const removed: string[] = [];
    const { deps, trashed } = executeDeps(f, {
      remove: vi.fn(async (path: string) => {
        removed.push(path);
        rmSync(path, { recursive: true, force: true });
      })
    });
    const result = await executeRepoRemoval(deps, {
      repoId: f.repoId,
      decisions: { checkouts: {}, branches: {} },
      deletePermanently: [f.wt("big")]
    });
    expect(result.ok && result.value.outcome).toBe("removed");
    expect(removed).toEqual([f.wt("big")]);
    expect(trashed).toEqual([f.repo]);
  });
});
