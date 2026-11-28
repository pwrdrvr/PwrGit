import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { markRetryableTestBody } from "../../../../../scripts/ci/vitest-test-body.ts";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";

let scratch: string;
let checkout: string;
let upstream: string;

const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };

function git(dir: string, args: string[], input?: string): string {
  return execFileSync("git", [
    "-C", dir, "-c", `core.hooksPath=${join(scratch, "no-hooks")}`, ...args
  ], { cwd: tmpdir(), encoding: "utf8", env: gitEnv, input }).trim();
}

/** Seed or clean up a property's generated branches in one Git transaction. */
function writeFixtureRefs(dir: string, commands: string[]): void {
  git(dir, ["update-ref", "--stdin"], `${commands.join("\n")}\n`);
}

function readRefs(dir: string, ...prefixes: string[]): string[] {
  return git(dir, ["for-each-ref", "--format=%(refname)", ...prefixes]).split("\n");
}

function oracleBranchNames(refs: string[], prefix: string): string[] {
  return refs
    .filter((ref) => ref.startsWith(`${prefix}oracle-`))
    .map((ref) => ref.slice(prefix.length));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function measureBranchWrites<T>(db: DB, action: () => Promise<T>) {
  const work = { upserts: 0, deletes: 0 };
  const prepare = db.prepare.bind(db);
  const prepares = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const mutation = /^(INSERT INTO|DELETE FROM) (?:local|remote)_branches\b/.exec(sql.trimStart());
    if (mutation !== null) {
      const run = statement.run.bind(statement);
      statement.run = (...args: unknown[]) => {
        if (mutation[1] === "INSERT INTO") work.upserts += 1;
        else work.deletes += 1;
        return run(...args);
      };
    }
    return statement;
  });
  const transactions = vi.spyOn(db, "transaction");
  try {
    return { result: await action(), ...work, transactions: transactions.mock.calls.length };
  } finally {
    prepares.mockRestore();
    transactions.mockRestore();
  }
}

beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-index-oracle-")));
  upstream = join(scratch, "upstream");
  checkout = join(scratch, "checkout");
  git(scratch, ["init", "-q", "-b", "main", upstream]);
  git(upstream, ["-c", "user.name=Oracle", "-c", "user.email=oracle@example.test",
    "-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "root"]);
  git(scratch, ["clone", "-q", "--origin", "origin", upstream, checkout]);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

it("reconciles a single ref mutation with writes bounded by the changed branch rows", async ({ task }) => {
  markRetryableTestBody(task);
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { minLength: 2, maxLength: 5 }),
    fc.integer({ min: 1, max: 4 }),
    async (suffixes, chunkSize) => {
      const localBranches = suffixes.map((suffix) => `oracle-local-${suffix}`);
      const remoteBranches = suffixes.map((suffix) => `oracle-remote-${suffix}`);
      const added = "oracle-remote-added";
      const renamed = "oracle-local-renamed";
      const remoteRef = (name: string) => `refs/remotes/origin/${name}`;
      const db = openDatabase(":memory:");
      try {
        const profiles = new ProfileService(db);
        const mine = profiles.create({ name: "Mine", email: "mine@example.test", roots: [checkout] });
        const theirs = profiles.create({ name: "Theirs", email: "theirs@example.test", roots: [upstream] });
        const indexer = new RepoIndexer(db, createSystemGit({ env: gitEnv }), { branchWriteChunkSize: chunkSize });
        writeFixtureRefs(checkout, localBranches.map((name) => `create refs/heads/${name} HEAD`));
        writeFixtureRefs(upstream, remoteBranches.map((name) => `create refs/heads/${name} HEAD`));
        git(checkout, ["fetch", "-q", "--prune", "origin"]);
        await indexer.rescanProfile(theirs);
        const [repo] = await indexer.rescanProfile(mine);
        if (repo === undefined) throw new Error("fixture checkout was not indexed");

        const search = (profileId: string) =>
          indexer.searchAll("oracle", { profileId, allProfiles: false })
            .filter(({ kind }) => kind === "local_branch" || kind === "remote_branch")
            .map(({ profileId, kind, name }) => ({ profileId, kind, name }));
        const checkSearch = () => {
          const refs = readRefs(checkout, "refs/heads/", "refs/remotes/origin/");
          const local = oracleBranchNames(refs, "refs/heads/");
          const remote = oracleBranchNames(refs, "refs/remotes/origin/");
          const hits = search(mine.id);
          expect(hits).toEqual(expect.arrayContaining([
            ...local.map((name) => ({ profileId: mine.id, kind: "local_branch", name })),
            ...remote.map((name) => ({ profileId: mine.id, kind: "remote_branch", name }))
          ]));
          expect(hits).toHaveLength(local.length + remote.length);
        };
        const otherHits = search(theirs.id);
        expect(otherHits).toHaveLength(suffixes.length);
        checkSearch();

        const checkRefresh = async (upserts: number, deletes: number, transactions: number) => {
          const measured = await measureBranchWrites(db, () => indexer.refreshRepoRemoteBranches(repo.id));
          expect(measured).toEqual({
            result: { ok: true, value: undefined }, upserts, deletes, transactions
          });
          checkSearch();
          expect(search(theirs.id)).toEqual(otherHits);
        };
        // The completion marker accounts for one transaction on each refresh.
        await checkRefresh(0, 0, 1);

        // A persisted ref can have the right id and stale metadata, e.g.
        // after changing which configured remote owns a tracking ref.
        const changedId = `${repo.id}:${remoteRef(remoteBranches[0]!)}`;
        db.prepare("UPDATE remote_branches SET name = 'oracle-stale', remote_name = 'old' WHERE id = ?")
          .run(changedId);
        await checkRefresh(1, 0, 2);
        expect(db.prepare("SELECT remote_name FROM remote_branches WHERE id = ?").pluck().get(changedId))
          .toBe("origin");

        writeFixtureRefs(checkout, [`create ${remoteRef(added)} HEAD`]);
        await checkRefresh(1, 0, 2);
        writeFixtureRefs(checkout, [`delete ${remoteRef(remoteBranches[0]!)}`]);
        await checkRefresh(0, 1, 2);
        writeFixtureRefs(checkout, [
          `delete ${remoteRef(added)}`,
          `create ${remoteRef("oracle-remote-renamed")} HEAD`
        ]);
        await checkRefresh(1, 1, 3);
        git(checkout, ["branch", "-m", localBranches[0]!, renamed]);
        await checkRefresh(1, 1, 3);

        // An upgraded database can start with empty derived tables and a
        // nonempty Git listing. A cold rebuild still writes in bounded chunks.
        db.prepare("DELETE FROM local_branches WHERE repo_id = ?").run(repo.id);
        db.prepare("DELETE FROM remote_branches WHERE repo_id = ?").run(repo.id);
        db.prepare("DELETE FROM remote_branch_index_state WHERE repo_id = ?").run(repo.id);
        await checkRefresh(2 * suffixes.length, 0, 1 + 2 * Math.ceil(suffixes.length / chunkSize));

        await expect(Promise.all([
          indexer.refreshRepoRemoteBranches(repo.id),
          indexer.refreshRepoRemoteBranches(repo.id)
        ])).resolves.toEqual([{ ok: true, value: undefined }, { ok: true, value: undefined }]);
        checkSearch();
        expect(search(theirs.id)).toEqual(otherHits);
      } finally {
        db.close();
        // A rename or deletion may already have removed some refs. Git
        // accepts a delete without an expected old ID for a missing ref.
        writeFixtureRefs(checkout, [...localBranches, renamed].map((name) => `delete refs/heads/${name}`));
        writeFixtureRefs(upstream, remoteBranches.map((name) => `delete refs/heads/${name}`));
        writeFixtureRefs(checkout, [...remoteBranches, added, "oracle-remote-renamed"]
          .map((name) => `delete ${remoteRef(name)}`));
      }
    }
  ), { numRuns: 8 });
});

it("indexes a recreated ref when refreshes reconcile different Git listings", async () => {
  const keeper = "oracle-a-keeper";
  const recreated = "oracle-z-recreated";
  const db = openDatabase(":memory:");
  const olderPaused = deferred();
  const releaseOlder = deferred();
  const newerListed = deferred();
  const releaseNewer = deferred();
  const pending: Promise<unknown>[] = [];
  let pauseOlder = false;
  let pauseNewer = false;
  let watchGit = false;
  let gitReads = 0;
  try {
    const profile = new ProfileService(db).create({
      name: "Mine", email: "mine@example.test", roots: [checkout]
    });
    const systemGit = createSystemGit({ env: gitEnv });
    const indexer = new RepoIndexer(db, async (...args) => {
      if (!watchGit) return systemGit(...args);
      gitReads += 1;
      try {
        return await systemGit(...args);
      } finally {
        gitReads -= 1;
        if (gitReads === 0) newerListed.resolve();
      }
    }, {
      branchWriteChunkSize: 1,
      yieldToEventLoop: async () => {
        if (pauseOlder) {
          pauseOlder = false;
          olderPaused.resolve();
          await releaseOlder.promise;
        } else if (pauseNewer) {
          pauseNewer = false;
          await releaseNewer.promise;
        }
      }
    });
    git(checkout, ["fetch", "-q", "--prune", "origin"]);
    git(checkout, ["branch", keeper]);
    git(checkout, ["branch", recreated]);
    const [repo] = await indexer.rescanProfile(profile);
    if (repo === undefined) throw new Error("fixture checkout was not indexed");

    git(checkout, ["branch", "-D", recreated]);
    pauseOlder = true;
    const older = indexer.refreshRepoRemoteBranches(repo.id);
    pending.push(older);
    await olderPaused.promise;

    git(checkout, ["branch", recreated]);
    watchGit = true;
    pauseNewer = true;
    const newer = indexer.refreshRepoRemoteBranches(repo.id);
    pending.push(newer);
    await newerListed.promise;
    // Let the listing's promise continuations reach the first write yield,
    // finish early, or wait for the older reconciliation's turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    watchGit = false;
    pauseNewer = false;
    releaseOlder.resolve();
    expect((await older).ok).toBe(true);
    releaseNewer.resolve();
    expect((await newer).ok).toBe(true);

    const hits = indexer.searchAll("oracle", { profileId: profile.id, allProfiles: false })
      .filter(({ kind }) => kind === "local_branch")
      .map(({ name }) => name)
      .sort();
    expect(hits).toEqual(oracleBranchNames(readRefs(checkout, "refs/heads/"), "refs/heads/"));
  } finally {
    releaseOlder.resolve();
    releaseNewer.resolve();
    await Promise.allSettled(pending);
    db.close();
    git(checkout, ["branch", "-D", keeper, recreated]);
  }
});

it.each(["during", "after"])("keeps the newer inventory when an older listing returns %s its reconciliation", async (when) => {
  const ref = "refs/remotes/origin/oracle-overlap";
  const added = "refs/remotes/origin/oracle-newer";
  const db = openDatabase(":memory:");
  const olderRead = deferred();
  const releaseOlder = deferred();
  const newerWrote = deferred();
  const releaseNewer = deferred();
  const pending: Promise<unknown>[] = [];
  let holdNextListing = false;
  let holdNextWrite = false;
  try {
    const profile = new ProfileService(db).create({
      name: "Mine", email: "mine@example.test", roots: [checkout]
    });
    const systemGit = createSystemGit({ env: gitEnv });
    const indexer = new RepoIndexer(db, async (args, cwd, options) => {
      const hold = holdNextListing && args[0] === "for-each-ref";
      if (hold) holdNextListing = false;
      const result = await systemGit(args, cwd, options);
      if (hold) {
        olderRead.resolve();
        await releaseOlder.promise;
      }
      return result;
    }, {
      branchWriteChunkSize: 1,
      yieldToEventLoop: async () => {
        if (!holdNextWrite) return;
        holdNextWrite = false;
        newerWrote.resolve();
        await releaseNewer.promise;
      }
    });
    writeFixtureRefs(checkout, [`create ${ref} HEAD`]);
    const [repo] = await indexer.rescanProfile(profile);
    if (repo === undefined) throw new Error("fixture checkout was not indexed");

    writeFixtureRefs(checkout, [`delete ${ref}`]);
    holdNextListing = true;
    const older = indexer.refreshRepoRemoteBranches(repo.id);
    pending.push(older);
    await olderRead.promise;

    writeFixtureRefs(checkout, [`create ${ref} HEAD`, `create ${added} HEAD`]);
    holdNextWrite = when === "during";
    const newer = indexer.refreshRepoRemoteBranches(repo.id);
    pending.push(newer);
    if (when === "during") {
      await newerWrote.promise;
      releaseOlder.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseNewer.resolve();
    }
    expect((await newer).ok).toBe(true);
    releaseOlder.resolve();
    expect((await older).ok).toBe(true);

    const hits = indexer.searchAll("oracle", { profileId: profile.id, allProfiles: false })
      .filter(({ kind }) => kind === "remote_branch")
      .map(({ name }) => name)
      .sort();
    expect(hits).toEqual(oracleBranchNames(readRefs(checkout, "refs/remotes/origin/"), "refs/remotes/origin/"));
  } finally {
    releaseOlder.resolve();
    releaseNewer.resolve();
    await Promise.allSettled(pending);
    db.close();
    writeFixtureRefs(checkout, [`delete ${ref}`, `delete ${added}`]);
  }
});

it.each(["scan", "worktree refresh", "manual index"])(
  "reconciles released and checked-out branches when a %s carries a stale listing",
  async (operation) => {
    const switched = "oracle-stale-snapshot-switch";
    const deleted = "oracle-stale-snapshot-delete";
    const db = openDatabase(":memory:");
    const olderRead = deferred();
    const releaseOlder = deferred();
    let holdNextListing = false;
    let pending: Promise<unknown> | undefined;
    try {
      const profiles = new ProfileService(db);
      const profile = profiles.create({
        name: "Mine", email: "mine@example.test", roots: [checkout]
      });
      const theirs = profiles.create({
        name: "Theirs", email: "theirs@example.test", roots: [upstream]
      });
      const releaseProbes: string[][] = [];
      const systemGit = createSystemGit({ env: gitEnv });
      const indexer = new RepoIndexer(db, async (args, cwd, options) => {
        if (args[0] === "for-each-ref" && args[2] === "--") releaseProbes.push(args.slice(3));
        const hold = holdNextListing && args[0] === "for-each-ref";
        if (hold) holdNextListing = false;
        const result = await systemGit(args, cwd, options);
        if (hold) {
          olderRead.resolve();
          await releaseOlder.promise;
        }
        return result;
      });
      writeFixtureRefs(checkout, [switched, deleted].map((name) => `create refs/heads/${name} HEAD`));
      await indexer.rescanProfile(theirs);
      const [repo] = await indexer.rescanProfile(profile);
      if (repo === undefined) throw new Error("fixture checkout was not indexed");

      git(checkout, ["switch", "--quiet", switched]);
      holdNextListing = true;
      const older = operation === "scan"
        ? indexer.rescanProfile(profile)
        : operation === "worktree refresh"
          ? indexer.refreshRepoWorktrees(repo.id)
          : indexer.indexRepoAt(profile.id, checkout);
      pending = older;
      await olderRead.promise;

      writeFixtureRefs(checkout, [`delete refs/heads/${deleted}`]);
      expect((await indexer.refreshRepoRemoteBranches(repo.id)).ok).toBe(true);
      releaseOlder.resolve();
      const result = await older;
      if ("ok" in result) expect(result.ok).toBe(true);

      const refs = readRefs(checkout, "refs/heads/").map((ref) => ref.slice("refs/heads/".length));
      const checkedOut = git(checkout, ["symbolic-ref", "--short", "HEAD"]);
      for (const name of ["main", switched, deleted]) {
        const kinds = indexer.searchAll(name, { profileId: profile.id, allProfiles: false })
          .filter((hit) => hit.name === name && (hit.kind === "worktree" || hit.kind === "local_branch"))
          .map(({ kind }) => kind);
        expect(kinds, name).toEqual(refs.includes(name)
          ? [name === checkedOut ? "worktree" : "local_branch"]
          : []);
      }
      expect(releaseProbes).toEqual([["refs/heads/main"]]);
      expect(indexer.searchAll("main", { profileId: theirs.id, allProfiles: false }))
        .toEqual([expect.objectContaining({ profileId: theirs.id, kind: "worktree", name: "main" })]);
    } finally {
      releaseOlder.resolve();
      await Promise.allSettled([pending]);
      db.close();
      git(checkout, ["switch", "--quiet", "main"]);
      writeFixtureRefs(checkout, [switched, deleted].map((name) => `delete refs/heads/${name}`));
    }
  }
);

it("does not restore a deleted released ref after waiting for a chunked refresh", async () => {
  const switched = "oracle-released-switch";
  const remote = "refs/remotes/origin/oracle-released-chunk";
  const main = "refs/heads/main";
  const db = openDatabase(":memory:");
  const indexPaused = deferred();
  const releaseIndex = deferred();
  const worktreeRead = deferred();
  const pending: Promise<unknown>[] = [];
  let pauseIndex = false;
  let watchWorktree = false;
  let releasedProbe: Promise<unknown> | undefined;
  try {
    const profile = new ProfileService(db).create({
      name: "Mine", email: "mine@example.test", roots: [checkout]
    });
    const systemGit = createSystemGit({ env: gitEnv });
    const indexer = new RepoIndexer(db, (args, cwd, options) => {
      const result = systemGit(args, cwd, options);
      if (watchWorktree && args[0] === "worktree" && args[1] === "list") {
        return result.then((output) => {
          worktreeRead.resolve();
          return output;
        });
      }
      if (args[0] === "for-each-ref" && args.at(-1) === main) releasedProbe = result;
      return result;
    }, {
      branchWriteChunkSize: 1,
      yieldToEventLoop: async () => {
        if (!pauseIndex) return;
        pauseIndex = false;
        indexPaused.resolve();
        await releaseIndex.promise;
      }
    });
    const [repo] = await indexer.rescanProfile(profile);
    if (repo === undefined) throw new Error("fixture checkout was not indexed");
    git(checkout, ["switch", "--quiet", "-c", switched]);
    writeFixtureRefs(checkout, [`delete ${main}`, `create ${remote} HEAD`]);

    pauseIndex = true;
    const index = indexer.refreshRepoRemoteBranches(repo.id);
    pending.push(index);
    await indexPaused.promise;

    // The running refresh observed main's deletion. Recreate it only while a
    // lightweight refresh can issue a probe outside the held write turn.
    writeFixtureRefs(checkout, [`create ${main} HEAD`]);
    watchWorktree = true;
    const worktrees = indexer.refreshRepoWorktrees(repo.id, { refreshBranches: false });
    pending.push(worktrees);
    await worktreeRead.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await releasedProbe;
    writeFixtureRefs(checkout, [`delete ${main}`]);
    releaseIndex.resolve();
    expect((await index).ok).toBe(true);
    expect((await worktrees).ok).toBe(true);

    expect(readRefs(checkout, "refs/heads/")).not.toContain(main);
    expect(indexer.searchAll("main", { profileId: profile.id, allProfiles: false })
      .filter(({ kind, name }) => kind === "local_branch" && name === "main")).toEqual([]);
  } finally {
    releaseIndex.resolve();
    await Promise.allSettled(pending);
    db.close();
    writeFixtureRefs(checkout, [`update ${main} HEAD`, `delete ${remote}`]);
    git(checkout, ["switch", "--quiet", "main"]);
    writeFixtureRefs(checkout, [`delete refs/heads/${switched}`]);
  }
});

it("keeps one search hit for a branch checked out during a chunked refresh", async () => {
  const first = "oracle-a-first";
  const switched = "oracle-z-switched";
  const db = openDatabase(":memory:");
  const indexPaused = deferred();
  const releaseIndex = deferred();
  const worktreeRead = deferred();
  const pending: Promise<unknown>[] = [];
  let pauseIndex = false;
  let watchWorktree = false;
  try {
    const profile = new ProfileService(db).create({
      name: "Mine", email: "mine@example.test", roots: [checkout]
    });
    const systemGit = createSystemGit({ env: gitEnv });
    const indexer = new RepoIndexer(db, async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      if (watchWorktree && args[0] === "worktree" && args[1] === "list") {
        worktreeRead.resolve();
      }
      return result;
    }, {
      branchWriteChunkSize: 1,
      yieldToEventLoop: async () => {
        if (!pauseIndex) return;
        pauseIndex = false;
        indexPaused.resolve();
        await releaseIndex.promise;
      }
    });
    const [repo] = await indexer.rescanProfile(profile);
    if (repo === undefined) throw new Error("fixture checkout was not indexed");
    writeFixtureRefs(checkout, [first, switched].map((name) => `create refs/heads/${name} HEAD`));

    pauseIndex = true;
    const index = indexer.refreshRepoRemoteBranches(repo.id);
    pending.push(index);
    await indexPaused.promise;
    git(checkout, ["switch", "--quiet", switched]);
    watchWorktree = true;
    const worktrees = indexer.refreshRepoWorktrees(repo.id, { refreshBranches: false });
    pending.push(worktrees);
    await worktreeRead.promise;
    // Let the lightweight refresh queue for the turn before releasing the delta.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseIndex.resolve();
    expect((await index).ok).toBe(true);
    expect((await worktrees).ok).toBe(true);

    expect(indexer.searchAll(switched, { profileId: profile.id, allProfiles: false }))
      .toEqual([expect.objectContaining({ kind: "worktree", name: switched })]);
    expect(indexer.searchAll("main", { profileId: profile.id, allProfiles: false }))
      .toContainEqual(expect.objectContaining({ kind: "local_branch", name: "main" }));
  } finally {
    releaseIndex.resolve();
    await Promise.allSettled(pending);
    db.close();
    git(checkout, ["switch", "--quiet", "main"]);
    writeFixtureRefs(checkout, [first, switched].map((name) => `delete refs/heads/${name}`));
  }
});

it("reconciles a cancelled chunked write on the next refresh", async () => {
  const refs = ["refs/remotes/origin/oracle-cancel-a", "refs/remotes/origin/oracle-cancel-b"];
  const db = openDatabase(":memory:");
  const controller = new AbortController();
  let abortOnYield = false;
  try {
    const profile = new ProfileService(db).create({
      name: "Mine", email: "mine@example.test", roots: [checkout]
    });
    const indexer = new RepoIndexer(db, createSystemGit({ env: gitEnv }), {
      branchWriteChunkSize: 1,
      yieldToEventLoop: async () => {
        if (abortOnYield) controller.abort();
      }
    });
    const [repo] = await indexer.rescanProfile(profile);
    if (repo === undefined) throw new Error("fixture checkout was not indexed");
    db.prepare("DELETE FROM remote_branch_index_state WHERE repo_id = ?").run(repo.id);
    writeFixtureRefs(checkout, refs.map((ref) => `create ${ref} HEAD`));

    abortOnYield = true;
    await expect(indexer.rescanProfile(profile, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(db.prepare("SELECT full_name FROM remote_branches WHERE repo_id = ?").pluck().all(repo.id))
      .toEqual(refs.slice(0, 1));
    const completed = db.prepare("SELECT repo_id FROM remote_branch_index_state WHERE repo_id = ?");
    expect(completed.get(repo.id)).toBeUndefined();

    abortOnYield = false;
    expect(await measureBranchWrites(db, () => indexer.refreshRepoRemoteBranches(repo.id))).toEqual({
      result: { ok: true, value: undefined }, upserts: 1, deletes: 0, transactions: 2
    });
    expect(completed.get(repo.id)).toEqual({ repo_id: repo.id });
    expect(db.prepare("SELECT full_name FROM remote_branches WHERE repo_id = ? ORDER BY full_name")
      .pluck().all(repo.id)).toEqual(refs);
  } finally {
    db.close();
    writeFixtureRefs(checkout, refs.map((ref) => `delete ${ref}`));
  }
});

it("keeps scan recency without rewriting search rows for an unchanged repository", async () => {
  const db = openDatabase(":memory:");
  try {
    const profiles = new ProfileService(db);
    const mine = profiles.create({ name: "Mine", email: "mine@example.test", roots: [checkout] });
    const theirs = profiles.create({ name: "Theirs", email: "theirs@example.test", roots: [checkout] });
    const indexer = new RepoIndexer(db, createSystemGit({ env: gitEnv }));
    git(checkout, ["branch", "oracle-recency"]);
    await indexer.rescanProfile(mine);

    db.exec(`
      UPDATE repos SET last_seen_at = '2000-01-01 00:00:00';
      CREATE TEMP TABLE search_updates (kind TEXT);
      CREATE TEMP TRIGGER record_search_update AFTER UPDATE ON search_fts
      BEGIN
        INSERT INTO search_updates VALUES (NEW.kind);
      END;
    `);
    await indexer.rescanProfile(mine);
    expect(db.prepare("SELECT last_seen_at FROM repos").pluck().get()).not.toBe("2000-01-01 00:00:00");
    expect(db.prepare("SELECT * FROM search_updates WHERE kind = 'local_branch'").all()).toEqual([]);

    await indexer.rescanProfile(theirs);
    expect(indexer.searchAll("oracle-recency", { profileId: mine.id, allProfiles: false })).toEqual([]);
    expect(indexer.searchAll("oracle-recency", { profileId: theirs.id, allProfiles: false }))
      .toEqual([expect.objectContaining({ profileId: theirs.id, kind: "local_branch", name: "oracle-recency" })]);
  } finally {
    db.close();
    git(checkout, ["branch", "-D", "oracle-recency"]);
  }
});
