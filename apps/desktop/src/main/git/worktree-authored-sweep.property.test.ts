import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { RECENT_MS, type Repo } from "@pwrgit/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { type GitExec } from "./dugite";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";
import { WorktreeStateService } from "./worktree-state";

let root: string;
let db: DB;
let oracleGit: GitExec;
let mine: Repo;
let other: Repo;
const myEmail = "mine@example.test";
const theirEmail = "theirs@example.test";
const now = Date.now();
const recent = new Date(now - 60_000).toISOString();
const old = new Date(now - RECENT_MS - 86_400_000).toISOString();
const since = new Date(now - RECENT_MS).toISOString();

function git(path: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", path, "-c", `core.hooksPath=${join(root, "no-hooks")}`, ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, "global"), GIT_CONFIG_NOSYSTEM: "1", ...env }
  }).trim();
}

function commit(path: string, name: string, date: string, authorDate = date): string {
  git(path, ["-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", name], {
    GIT_AUTHOR_NAME: "Author", GIT_AUTHOR_EMAIL: myEmail, GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_NAME: "Committer", GIT_COMMITTER_EMAIL: myEmail, GIT_COMMITTER_DATE: date
  });
  return git(path, ["rev-parse", "HEAD"]);
}

let oldTip: string;
let recentTip: string;
beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-authored-oracle-")));
  db = openDatabase(":memory:");
  oracleGit = createSystemGit({ env: {
    ...process.env, GIT_CONFIG_GLOBAL: join(root, "global"), GIT_CONFIG_NOSYSTEM: "1"
  } });
  const profiles = new ProfileService(db);
  const indexer = new RepoIndexer(db, oracleGit);
  for (const name of ["mine", "other"]) {
    const profile = profiles.create({ name, email: "profile@example.test" });
    const path = join(root, name);
    git(root, ["init", "-q", "-b", "main", path]);
    git(path, ["config", "user.email", myEmail]);
    const warm = commit(path, "recent parent", recent);
    // --since prunes an old tip even when its parent happens to be newer.
    const cold = commit(path, "old tip on a recent parent", old);
    for (const branch of ["one", "two", "three", "four"]) {
      git(path, ["worktree", "add", "-q", "-b", branch, join(root, `${name}-${branch}`), cold]);
    }
    git(path, ["pack-refs", "--all"]);
    const indexed = await indexer.indexRepoAt(profile.id, path);
    if (!indexed.ok) throw new Error(indexed.error.message);
    for (const w of indexed.value.worktrees) {
      db.prepare(`INSERT INTO worktree_state (
        worktree_id, branch, head, has_upstream, ahead, behind, dirty, behind_default,
        default_branch, merged_into_default, is_default_branch, updated_at
      ) VALUES (?, ?, '', 0, 0, 0, 0, 0, 'main', 0, 0, 'startup')`).run(w.id, w.branch);
    }
    if (name === "mine") {
      mine = indexed.value;
      recentTip = warm;
      oldTip = cold;
    } else other = indexed.value;
  }
});
afterAll(() => {
  db?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

async function checkoutOracle(path: string): Promise<string | undefined> {
  const logs = await oracleGit(["log", `--since=${since}`, "--max-count=2000", "--format=%ae%x09%aI", "HEAD"], path);
  const author = await oracleGit(["config", "--get", "user.email"], path);
  if (!logs.ok || logs.value.exitCode !== 0 || !author.ok || author.value.exitCode !== 0) return undefined;
  const expectedEmail = author.value.stdout.trim().toLowerCase();
  const match = logs.value.stdout.split("\n").map(line => line.split("\t")).find(
    ([email, at]) => email?.toLowerCase() === expectedEmail && at !== undefined && Date.parse(at) >= Date.parse(since)
  );
  return match?.[1];
}

it("agrees with checkout-local Git and omits old-tip logs across both profiles", async () => {
  const counted: string[] = [];
  const state = new WorktreeStateService(db, (args, path, options) => {
    if (args[0] === "log") counted.push(path);
    return oracleGit(args, path, options);
  });
  const changed = mine.worktrees.find(w => w.branch === "one")!;
  const conditional = join(root, "identity");
  writeFileSync(conditional, `[user]\n\temail = ${theirEmail}\n`);
  git(mine.path, ["config", "includeIf.onbranch:one.path", conditional]);
  const detached = mine.worktrees.find(w => w.branch === "two")!;
  git(detached.path, ["checkout", "-q", "--detach", oldTip]);
  const replaced = mine.worktrees.find(w => w.branch === "three")!;
  // A fresh commit date can coexist with an expired author date.
  git(replaced.path, ["reset", "-q", "--hard", oldTip]);
  commit(replaced.path, "rebased old work", recent, old);
  const worktreeIdentity = mine.worktrees.find(w => w.branch === "four")!;
  git(mine.path, ["config", "extensions.worktreeConfig", "true"]);

  await fc.assert(fc.asyncProperty(
    fc.record({
      warm: fc.boolean(), matches: fc.boolean(), replacement: fc.boolean(), detachedWarm: fc.boolean()
    }),
    async ({ warm, matches, replacement, detachedWarm }) => {
      git(changed.path, ["reset", "-q", "--hard", warm ? recentTip : oldTip]);
      git(worktreeIdentity.path, ["reset", "-q", "--hard", warm ? recentTip : oldTip]);
      git(worktreeIdentity.path, ["config", "--worktree", "user.email", matches ? myEmail.toUpperCase() : theirEmail]);
      git(detached.path, ["checkout", "-q", "--detach", detachedWarm ? recentTip : oldTip]);
      if (replacement) git(mine.path, ["replace", "-f", oldTip, recentTip]);
      else if (git(mine.path, ["replace", "--list"]) !== "") git(mine.path, ["replace", "-d", oldTip]);
      const trees = [...mine.worktrees, ...other.worktrees];
      const prior = new Map(trees.map(w => [w.id, state.getCached(w.id)?.lastAuthoredAt]));
      counted.length = 0;
      const moved = await state.sweepAuthored();
      const expected = await Promise.all(trees.map(w => checkoutOracle(w.path)));
      expect(trees.map(w => state.getCached(w.id)?.lastAuthoredAt)).toEqual(expected);
      const changedMine = mine.worktrees.some((w, i) => prior.get(w.id) !== expected[i]);
      expect([...moved]).toEqual(changedMine ? [[mine.profileId, [mine.id]]] : []);
      // All of the second profile's tips are old, including packed tips.
      expect(counted.filter(path => other.worktrees.some(w => w.path === path))).toEqual([]);
      expect(counted).toContain(detached.path);
      if (replacement) expect(counted).toContain(replaced.path);
    }
  ), { numRuns: 8 });
});

it("falls back when a cold ref moves before the batch can be consumed", async () => {
  const target = other.worktrees.find(w => w.branch === "one")!;
  const cold = git(target.path, ["rev-parse", "HEAD"]);
  let newDate: string | undefined;
  try {
    const state = new WorktreeStateService(db, async (args, path, options) => {
      const result = await oracleGit(args, path, options);
      if (args[0] === "for-each-ref" && path === other.path) {
        commit(target.path, "external commit during sweep", recent);
        newDate = await checkoutOracle(target.path);
      }
      return result;
    });
    const moved = await state.sweepAuthored();
    expect(newDate).toBeDefined();
    expect(state.getCached(target.id)?.lastAuthoredAt).toBe(newDate);
    expect(moved.get(other.profileId)).toEqual([other.id]);
  } finally {
    git(target.path, ["reset", "-q", "--hard", cold]);
  }
});
