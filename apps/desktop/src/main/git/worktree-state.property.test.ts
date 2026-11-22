import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { WorktreeStateService } from "./worktree-state";
import { createSystemGit } from "./test-support/system-git";
import type { GitExec } from "./dugite";
import { createWorktreeRefresher } from "./worktree-handlers";
import { readDefaultComparisons } from "./worktree-default-comparison";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));

const realGit = createSystemGit();
function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

// Keep all 50 generated cases, but budget ten full probes per test. On
// Windows, 50 probes plus their independent Git oracles exceed the 20s test
// deadline. Each property and the fixed regressions own separate fixtures so
// a timed-out generator cannot mutate any later test's repository.
describe.each(["regressions", 0, 1, 2, 3, 4] as const)("worktree default ancestry: Git oracle and subprocess budget (batch %s)", (batch) => {
  let root: string;
  let primary: string;
  let linked: string;
  let db: DB;
  let service: WorktreeStateService;
  let worktreeId: string;
  const commits: string[] = [];
  let calls: string[][] = [];

  beforeAll(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-state-ancestry-")));
    primary = join(root, "primary");
    linked = join(root, "linked");
    execFileSync("git", ["init", "-q", "-b", "main", primary]);
    git(primary, "config", "user.email", "oracle@example.test");
    git(primary, "config", "user.name", "Oracle");
    git(primary, "config", "core.autocrlf", "false");
    git(primary, "config", "gc.auto", "0");
    const commit = (message: string): void => {
      git(primary, "commit", "-q", "--allow-empty", "-m", message);
      commits.push(git(primary, "rev-parse", "HEAD"));
    };
    commit("root");
    git(primary, "branch", "base");
    git(primary, "switch", "-c", "left");
    commit("left");
    git(primary, "branch", "left-before");
    git(primary, "switch", "-c", "right", "base");
    commit("right");
    git(primary, "branch", "right-before");
    // Criss-cross history: left and right now have two best merge bases.
    git(primary, "switch", "left");
    git(primary, "merge", "-q", "--no-ff", "right-before", "-m", "left merge");
    commits.push(git(primary, "rev-parse", "HEAD"));
    git(primary, "switch", "right");
    git(primary, "merge", "-q", "--no-ff", "left-before", "-m", "right merge");
    commits.push(git(primary, "rev-parse", "HEAD"));
    git(primary, "switch", "--orphan", "unrelated");
    commit("unrelated root");
    git(primary, "switch", "main");
    commit("main advance");
    git(primary, "worktree", "add", "-q", "-b", "probe", linked);

    db = openDatabase(":memory:");
    const profile = new ProfileService(db).create({ name: "Oracle", email: "oracle@example.test" });
    const indexed = await new RepoIndexer(db, realGit).indexRepoAt(profile.id, primary);
    if (!indexed.ok) throw new Error(indexed.error.message);
    const row = indexed.value.worktrees.find((w) => w.branch === "probe");
    if (row === undefined) throw new Error("linked worktree not indexed");
    worktreeId = row.id;
    const countedGit: GitExec = (args, cwd, options) => {
      calls.push([...args]);
      return realGit(args, cwd, options);
    };
    service = new WorktreeStateService(db, countedGit);
    await service.resolveDefaultBranch(indexed.value.id, primary);
  });

  afterAll(() => {
    db?.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  async function check(head: string, target: string, detached: boolean, packed: boolean): Promise<void> {
    git(primary, "reset", "--hard", target);
    if (detached) git(linked, "switch", "--detach", head);
    else git(linked, "switch", "-C", "probe", head);
    if (packed) git(primary, "pack-refs", "--all");
    calls = [];
    const state = await service.compute(worktreeId);
    const [base, ancestor] = await Promise.all([
      realGit(["merge-base", head, target], primary),
      realGit(["merge-base", "--is-ancestor", head, target], primary)
    ]);
    if (!base.ok || !ancestor.ok) throw new Error("oracle could not run");
    expect([0, 1]).toContain(base.value.exitCode);
    expect([0, 1]).toContain(ancestor.value.exitCode);
    const related = base.value.exitCode === 0;
    const behind = related ? Number(git(primary, "rev-list", "--count", `${head}..${target}`)) : 0;
    expect(state).toMatchObject({
      head, defaultBranch: "main", isDefaultBranch: false,
      mergedIntoDefault: ancestor.value.exitCode === 0,
      divergedFromDefault: !related,
      behindDefault: behind
    });
    // The common-ancestor query already proves containment when its answer
    // equals HEAD. A second Git child to ask is-ancestor is redundant.
    expect(calls.filter((args) => args[0] === "merge-base")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "rev-list" && args[1] === "--count" && args[2]?.includes(".."))).toHaveLength(Number(related));
  }

  if (batch !== "regressions") {
    it("agrees with git for arbitrary pairs in merged, forked, unrelated and packed history", async () => {
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 6 }), fc.boolean(), fc.boolean(),
        (head, target, detached, packed) => check(commits[head]!, commits[target]!, detached, packed)
      ), { numRuns: 10 });
    });
    return;
  }

  it("uses one ancestry child for an already-contained branch", async () => {
    await check(commits[0]!, commits[1]!, false, false);
  });

  it("does not treat criss-cross histories with two best bases as merged", async () => {
    expect(git(primary, "merge-base", "--all", commits[3]!, commits[4]!).split("\n")).toHaveLength(2);
    await check(commits[3]!, commits[4]!, true, true);
  });

  it("keeps ancestry tied to the status snapshot when an external checkout moves HEAD", async () => {
    git(primary, "reset", "--hard", commits[1]!);
    git(linked, "switch", "-C", "probe", commits[0]!);
    let moved = false;
    const movingGit: GitExec = async (args, cwd, options) => {
      const result = await realGit(args, cwd, options);
      if (args[0] === "status" && !moved) {
        moved = true;
        git(linked, "reset", "--hard", commits[6]!);
      }
      return result;
    };
    const state = await new WorktreeStateService(db, movingGit).compute(worktreeId);
    // The returned head is the root from status; the later HEAD is a sibling
    // of default, so using the moving name would contradict that snapshot.
    expect(state).toMatchObject({ head: commits[0], mergedIntoDefault: true, behindDefault: 1 });
    expect(git(linked, "rev-parse", "HEAD")).toBe(commits[6]);
  });

  it("shares concurrent default-ref validation and checks the ref again on the next read", async () => {
    const countedGit: GitExec = (args, cwd, options) => {
      calls.push([...args]);
      return realGit(args, cwd, options);
    };
    const isolated = new WorktreeStateService(db, countedGit);
    await isolated.resolveDefaultBranch("shared", primary);
    calls = [];
    const defaults = await Promise.all(
      Array.from({ length: 4 }, () => isolated.resolveDefaultBranch("shared", primary))
    );
    expect(defaults).toEqual(Array.from({ length: 4 }, () => ({ name: "main", ref: "main" })));
    expect(calls).toEqual([["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]]);

    git(primary, "branch", "-m", "main", "master");
    try {
      const live = await isolated.resolveDefaultBranch("shared", primary);
      expect(live).toEqual({ name: "master", ref: "master" });
    } finally {
      git(primary, "branch", "-m", "master", "main");
    }
  });

  it("batches family comparisons by live commit and falls back if the default moves", async () => {
    const repoId = (db.prepare("SELECT repo_id FROM worktrees WHERE id = ?")
      .get(worktreeId) as { repo_id: string }).repo_id;
    const family = Array.from({ length: 8 }, (_, i) => ({
      branch: `family-${i}`,
      path: join(root, `family-${i}`),
      head: commits[i % commits.length]!
    }));
    for (const row of family) git(primary, "worktree", "add", "-b", row.branch, row.path, row.head);
    const indexed = await new RepoIndexer(db, realGit).refreshRepoWorktrees(repoId);
    if (!indexed.ok) throw new Error(indexed.error.message);
    const ids = db.prepare("SELECT id, branch FROM worktrees WHERE repo_id = ?").all(repoId) as
      Array<{ id: string; branch: string }>;
    const other = new ProfileService(db).create({ name: "Other profile", email: "other@example.test" });
    db.prepare("INSERT INTO repos (id, profile_id, path, name) VALUES (?, ?, ?, ?)").run(
      "other", other.id, join(root, "other"), "Other"
    );
    db.prepare("INSERT INTO worktrees (id, repo_id, path, branch) VALUES (?, ?, ?, ?)").run(
      "other-worktree", "other", join(root, "other"), "main"
    );

    let externalMove = false;
    const countedGit: GitExec = async (args, cwd, options) => {
      calls.push([...args]);
      const result = await realGit(args, cwd, options);
      if (externalMove && args[0] === "for-each-ref" && args.includes("--stdin")) {
        git(primary, "reset", "--hard", commits[4]!);
      }
      return result;
    };
    const isolated = new WorktreeStateService(db, countedGit);
    const refresher = createWorktreeRefresher(isolated, db);
    for (const move of [false, true]) {
      git(primary, "reset", "--hard", commits[6]!);
      externalMove = move;
      calls = [];
      await refresher.refreshRepoWorktrees(repoId);
      const fullComparisonChildren = calls.filter((a) => a[0] === "merge-base");
      expect(calls.filter((a) => a[0] === "for-each-ref" && a.includes("--stdin"))).toHaveLength(1);
      expect(fullComparisonChildren.length).toBeLessThan(move ? ids.length : 2);
      if (move) expect(fullComparisonChildren.length).toBeGreaterThanOrEqual(family.length);
      expect(isolated.getCached("other-worktree")).toBeNull();
      const target = git(primary, "rev-parse", "main");
      for (const row of family) {
        const state = isolated.getCached(ids.find(({ branch }) => branch === row.branch)!.id);
        const base = await realGit(["merge-base", row.head, target], primary);
        if (!base.ok) throw new Error(base.error.message);
        const related = base.value.exitCode === 0;
        expect(state).toMatchObject({
          head: row.head,
          behindDefault: related ? Number(git(primary, "rev-list", "--count", `${row.head}..${target}`)) : 0,
          mergedIntoDefault: base.value.stdout.trim() === row.head,
          divergedFromDefault: !related,
          lastActivityAt: git(primary, "log", "-1", "--format=%cI", row.head)
        });
      }
    }
  });

  it("reads only enough default history to distinguish near-tip divergence from unrelated history", async () => {
    const base = commits[6]!;
    const countedGit: GitExec = (args, cwd, options) => {
      calls.push([...args]);
      return realGit(args, cwd, options);
    };
    git(primary, "reset", "--hard", base);
    calls = [];
    const contained = await readDefaultComparisons(countedGit, primary, "main", base, ["refs/heads/base"]);
    expect(contained?.byHead.get(commits[0]!)).toMatchObject({ behindDefault: 1, mergedIntoDefault: true });
    expect(calls.filter(([command]) => command === "rev-list")).toEqual([]);
    calls = [];
    const diverged = await readDefaultComparisons(countedGit, primary, "main", base, ["refs/heads/left"]);
    expect(diverged?.byHead.get(commits[3]!)).toMatchObject({ behindDefault: 1, divergedFromDefault: false });
    expect(calls.filter(([command]) => command === "rev-list")).toEqual([
      ["rev-list", "--count", "--max-count=2", base]
    ]);
  });

  it.each(["replace", "graft", "private ref"] as const)("uses checkout-local ancestry when a later worktree sees a %s change", async (kind) => {
    const repoId = (db.prepare("SELECT repo_id FROM worktrees WHERE id = ?")
      .get(worktreeId) as { repo_id: string }).repo_id;
    const prefix = kind === "private ref" ? "private" : kind;
    const branches = Array.from({ length: 8 }, (_, i) => `${prefix}-${i}`);
    const lateBranch = branches.at(-1)!;
    const latePath = join(root, lateBranch);
    const base = commits[6]!;
    const head = commits[0]!;
    git(primary, "reset", "--hard", base);
    for (const branch of branches) git(primary, "worktree", "add", "-b", branch, join(root, branch), head);
    const indexed = await new RepoIndexer(db, realGit).refreshRepoWorktrees(repoId);
    if (!indexed.ok) throw new Error(indexed.error.message);
    const rows = (db.prepare("SELECT id, branch FROM worktrees WHERE repo_id = ? ORDER BY branch")
      .all(repoId) as Array<{ id: string; branch: string }>).filter(({ branch }) => branches.includes(branch));
    const grafts = join(primary, ".git", "info", "grafts");
    const def = kind === "private ref" ? "worktree/main" : "main";
    if (kind === "private ref") git(primary, "branch", "-m", "main", def);
    let changed = false;
    const exec: GitExec = async (args, cwd, options) => {
      if (args[0] === "status" && cwd === latePath && !changed) {
        changed = true;
        if (kind === "replace") git(primary, "replace", base, commits[5]!);
        if (kind === "graft") writeFileSync(grafts, `${base}\n`);
        if (kind === "private ref") git(latePath, "update-ref", "refs/worktree/main", commits[5]!);
      }
      return realGit(args, cwd, options);
    };
    try {
      const isolated = new WorktreeStateService(db, exec);
      await isolated.resolveDefaultBranch(repoId, primary);
      await isolated.refreshMany(rows, 1);
      expect(changed).toBe(true);
      const merge = await realGit(["merge-base", head, def], latePath);
      if (!merge.ok) throw new Error(merge.error.message);
      expect(merge.value.exitCode).toBe(1);
      expect(isolated.getCached(rows.at(-1)!.id)).toMatchObject({
        head, defaultBranch: def, mergedIntoDefault: false, behindDefault: 0, divergedFromDefault: true
      });
    } finally {
      if (kind === "replace" && changed) git(primary, "replace", "-d", base);
      if (kind === "graft") rmSync(grafts, { force: true });
      if (kind === "private ref") {
        git(latePath, "update-ref", "-d", "refs/worktree/main");
        git(primary, "branch", "-m", def, "main");
      }
    }
  });

  it.each([1, 2])("matches Git through a depth-%s shallow boundary", async (depth) => {
    const source = join(root, `shallow-source-${depth}`);
    const shallow = join(root, `shallow-${depth}`);
    git(root, "init", "-b", "main", source);
    const commit = (path: string, message: string): string =>
      git(path, "-c", "user.name=Oracle", "-c", "user.email=oracle@example.test",
        "commit", "--allow-empty", "-m", message);
    for (const message of ["root", "fork point", "main tip"]) commit(source, message);
    git(source, "switch", "-c", "side", "HEAD~1");
    commit(source, "side tip");
    git(source, "switch", "main");
    git(root, "clone", `--depth=${depth}`, "--no-single-branch", pathToFileURL(source).href, shallow);
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    git(shallow, "branch", "other-tip", "origin/side");
    git(shallow, "switch", "-c", "ahead");
    commit(shallow, "shallow local advance");
    const base = git(shallow, "rev-parse", "main");
    const branches = ["main", "ahead", "other-tip"].map((name) => `refs/heads/${name}`);
    const batch = await readDefaultComparisons(realGit, shallow, "main", base, branches);
    expect(batch).not.toBeNull();
    for (const ref of branches) {
      const head = git(shallow, "rev-parse", ref);
      const merge = await realGit(["merge-base", head, base], shallow);
      if (!merge.ok) throw new Error(merge.error.message);
      const related = merge.value.exitCode === 0;
      expect(batch?.byHead.get(head)).toMatchObject({
        behindDefault: related ? Number(git(shallow, "rev-list", "--count", `${head}..${base}`)) : 0,
        mergedIntoDefault: merge.value.stdout.trim() === head,
        divergedFromDefault: !related
      });
    }

    let deepened = false;
    const changingGit: GitExec = async (args, cwd, options) => {
      const result = await realGit(args, cwd, options);
      if (args[0] === "for-each-ref" && args.includes("--stdin")) {
        git(shallow, "fetch", "--unshallow", "origin");
        deepened = true;
      }
      return result;
    };
    expect(await readDefaultComparisons(changingGit, shallow, "main", base, branches)).toBeNull();
    expect(deepened).toBe(true);
  });
});
