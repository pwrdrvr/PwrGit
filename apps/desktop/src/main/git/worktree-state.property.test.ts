import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { WorktreeStateService } from "./worktree-state";
import { createSystemGit } from "./test-support/system-git";
import type { GitExec } from "./dugite";

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
});
