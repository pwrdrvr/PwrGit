import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";

let scratch: string;
let checkout: string;
let upstream: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", [
    "-C", dir, "-c", `core.hooksPath=${join(scratch, "no-hooks")}`, ...args
  ], { encoding: "utf8" }).trim();
}

function oracleRefs(dir: string, prefix: string): string[] {
  return git(dir, "for-each-ref", "--format=%(refname)", prefix)
    .split("\n")
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

beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-index-oracle-")));
  upstream = join(scratch, "upstream");
  checkout = join(scratch, "checkout");
  git(scratch, "init", "-q", "-b", "main", upstream);
  git(upstream, "-c", "user.name=Oracle", "-c", "user.email=oracle@example.test",
    "-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "root");
  git(scratch, "clone", "-q", "--origin", "origin", upstream, checkout);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

it("reconciles refs with scoped search and starts no branch transactions for matching rows", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { minLength: 2, maxLength: 5 }),
    fc.integer({ min: 1, max: 4 }),
    async (suffixes, chunkSize) => {
      const db = openDatabase(":memory:");
      try {
        const profiles = new ProfileService(db);
        const mine = profiles.create({ name: "Mine", email: "mine@example.test", roots: [checkout] });
        const theirs = profiles.create({ name: "Theirs", email: "theirs@example.test", roots: [upstream] });
        const indexer = new RepoIndexer(db, createSystemGit(), { branchWriteChunkSize: chunkSize });
        for (const suffix of suffixes) {
          git(checkout, "branch", `oracle-local-${suffix}`);
          git(upstream, "branch", `oracle-remote-${suffix}`);
        }
        git(checkout, "fetch", "-q", "--prune", "origin");
        await indexer.rescanProfile(theirs);
        const [repo] = await indexer.rescanProfile(mine);
        if (repo === undefined) throw new Error("fixture checkout was not indexed");

        const search = (profileId: string) =>
          indexer.searchAll("oracle", { profileId, allProfiles: false })
            .filter(({ kind }) => kind === "local_branch" || kind === "remote_branch")
            .map(({ profileId, kind, name }) => ({ profileId, kind, name }));
        const checkSearch = () => {
          const local = oracleRefs(checkout, "refs/heads/");
          const remote = oracleRefs(checkout, "refs/remotes/origin/");
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

        const transactions = vi.spyOn(db, "transaction");
        try {
          expect(await indexer.refreshRepoRemoteBranches(repo.id)).toEqual({ ok: true, value: undefined });
          // The branch index completion marker uses one transaction.
          expect(transactions.mock.calls.length).toBeLessThanOrEqual(1);
        } finally {
          transactions.mockRestore();
        }

        // A persisted ref can have the right id and stale metadata, e.g.
        // after changing which configured remote owns a tracking ref.
        db.prepare("UPDATE remote_branches SET remote_name = 'old' WHERE repo_id = ?").run(repo.id);
        expect((await indexer.refreshRepoRemoteBranches(repo.id)).ok).toBe(true);
        expect(db.prepare("SELECT DISTINCT remote_name FROM remote_branches WHERE repo_id = ?")
          .pluck().all(repo.id)).toEqual(["origin"]);

        const [first] = suffixes;
        git(checkout, "branch", "-m", `oracle-local-${first}`, "oracle-renamed");
        git(upstream, "branch", "-D", `oracle-remote-${first}`);
        git(checkout, "fetch", "-q", "--prune", "origin");
        await expect(Promise.all([
          indexer.refreshRepoRemoteBranches(repo.id),
          indexer.refreshRepoRemoteBranches(repo.id)
        ])).resolves.toEqual([{ ok: true, value: undefined }, { ok: true, value: undefined }]);
        checkSearch();
        expect(search(theirs.id)).toEqual(otherHits);
      } finally {
        db.close();
        for (const dir of [checkout, upstream]) {
          const branches = oracleRefs(dir, "refs/heads/");
          if (branches.length > 0) git(dir, "branch", "-D", ...branches);
        }
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
    const systemGit = createSystemGit();
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
    git(checkout, "fetch", "-q", "--prune", "origin");
    git(checkout, "branch", keeper);
    git(checkout, "branch", recreated);
    const [repo] = await indexer.rescanProfile(profile);
    if (repo === undefined) throw new Error("fixture checkout was not indexed");

    git(checkout, "branch", "-D", recreated);
    pauseOlder = true;
    const older = indexer.refreshRepoRemoteBranches(repo.id);
    pending.push(older);
    await olderPaused.promise;

    git(checkout, "branch", recreated);
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
    expect(hits).toEqual(oracleRefs(checkout, "refs/heads/"));
  } finally {
    releaseOlder.resolve();
    releaseNewer.resolve();
    await Promise.allSettled(pending);
    db.close();
    git(checkout, "branch", "-D", keeper, recreated);
  }
});

it("keeps scan recency without rewriting search rows for an unchanged repository", async () => {
  const db = openDatabase(":memory:");
  try {
    const profiles = new ProfileService(db);
    const mine = profiles.create({ name: "Mine", email: "mine@example.test", roots: [checkout] });
    const theirs = profiles.create({ name: "Theirs", email: "theirs@example.test", roots: [checkout] });
    const indexer = new RepoIndexer(db, createSystemGit());
    git(checkout, "branch", "oracle-recency");
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
    git(checkout, "branch", "-D", "oracle-recency");
  }
});
