import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec, GitOutput } from "./dugite";
import { findRepoDirs, RepoIndexer, scanRepoRoot } from "./repo-indexer";

// Drive the indexer with system git so the test is independent of dugite's
// bundled binary. Address the repo with `-C` and keep the process cwd out of
// it, exactly as `gitProcessInvocation` does in production: several tests here
// rename a scanned directory out from under a git run, and on Windows a
// descendant git.exe still holding it as its native cwd fails that rename with
// EPERM/EBUSY (see this directory's AGENTS.md).
const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", ["-C", cwd, ...args], { cwd: tmpdir() });
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

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "Tester"]);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}

let root: string;
let profileService: ProfileService;
let indexer: RepoIndexer;
let profileId: string;
let db: ReturnType<typeof openDatabase>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-scan-"));

  // repoA with a linked worktree on branch "feature"
  const repoA = join(root, "repoA");
  initRepo(repoA);
  const repoAWt = join(root, "repoA-wt");
  git(repoA, ["worktree", "add", repoAWt, "-b", "feature"]);

  // repoB nested one level down
  initRepo(join(root, "group", "repoB"));

  // a repo hidden inside node_modules — must be skipped by the scan
  initRepo(join(root, "app", "node_modules", "pkg"));

  // a plain non-repo folder
  mkdirSync(join(root, "plain"), { recursive: true });

  db = openDatabase(":memory:");
  profileService = new ProfileService(db);
  const p = profileService.create({
    name: "Scan",
    email: "s@x.com",
    roots: [root]
  });
  profileId = p.id;
  indexer = new RepoIndexer(db, systemGit);
});

describe("findRepoDirs", () => {
  it("finds repos and worktrees but skips node_modules and plain dirs", () => {
    const dirs = findRepoDirs(root);
    expect(dirs.some((d) => d.endsWith("repoA"))).toBe(true);
    expect(dirs.some((d) => d.endsWith("repoA-wt"))).toBe(true);
    expect(dirs.some((d) => d.endsWith(join("group", "repoB")))).toBe(true);
    expect(dirs.some((d) => d.includes("node_modules"))).toBe(false);
    expect(dirs.some((d) => d.endsWith("plain"))).toBe(false);
  });

  it("discovers asynchronously with bounded event-loop yields", async () => {
    let yields = 0;
    const scan = await scanRepoRoot(root, undefined, {
      yieldEvery: 1,
      yieldToEventLoop: async () => {
        yields += 1;
      }
    });

    expect(new Set(scan.dirs)).toEqual(new Set(findRepoDirs(root)));
    expect(scan.rootReadable).toBe(true);
    expect(yields).toBeGreaterThan(0);
  });

  it("tells an unreadable root apart from an empty one", async () => {
    // Both scans come back with no dirs; only `rootReadable` says whether that
    // means "nothing here" or "could not look". An unmounted volume takes the
    // missing-path branch — the mount point is simply not there to list.
    const emptyRoot = mkdtempSync(join(tmpdir(), "pwrgit-empty-root-"));
    const missingRoot = join(emptyRoot, "never-created");

    await expect(scanRepoRoot(emptyRoot)).resolves.toEqual({
      dirs: [],
      rootReadable: true
    });
    await expect(scanRepoRoot(missingRoot)).resolves.toEqual({
      dirs: [],
      rootReadable: false
    });
  });
});

describe("RepoIndexer", () => {
  it("throttles routine root discovery after a successful scan", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pwrgit-schedule-"));
    initRepo(join(isolatedRoot, "scheduled"));
    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Scheduled",
      email: "scheduled@example.com",
      roots: [isolatedRoot]
    });
    let now = 1_000;
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit, {
      now: () => now,
      profileRescanIntervalMs: 100
    });

    expect(isolatedIndexer.shouldRescanProfile(profile.id)).toBe(true);
    await isolatedIndexer.rescanProfile(profile);
    expect(isolatedIndexer.shouldRescanProfile(profile.id)).toBe(false);

    now += 99;
    expect(isolatedIndexer.shouldRescanProfile(profile.id)).toBe(false);
    now += 1;
    expect(isolatedIndexer.shouldRescanProfile(profile.id)).toBe(true);
  });

  it("stops a deleted profile's scan before reused ids can be written", async () => {
    const scanRoot = mkdtempSync(join(tmpdir(), "pwrgit-cancel-scan-"));
    const repoPath = join(scanRoot, "old-root-repo");
    initRepo(repoPath);
    const isolatedDb = openDatabase(":memory:");
    try {
      const profiles = new ProfileService(isolatedDb);
      const deleted = profiles.create({
        name: "Reusable",
        email: "old@example.com",
        roots: [scanRoot]
      });
      profiles.create({ name: "Survivor", email: "survivor@example.com" });

      let announceYield = (): void => undefined;
      const reachedWriteBoundary = new Promise<void>((resolve) => {
        announceYield = resolve;
      });
      let resume = (): void => undefined;
      const resumeScan = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let paused = false;
      const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit, {
        yieldToEventLoop: async () => {
          if (paused) return;
          paused = true;
          announceYield();
          await resumeScan;
        }
      });
      const controller = new AbortController();
      const scan = isolatedIndexer.rescanProfile(deleted, {
        signal: controller.signal
      });
      await reachedWriteBoundary;

      const removal = profiles.delete({
        profileId: deleted.id,
        expectedName: deleted.name
      });
      expect(removal.ok).toBe(true);
      controller.abort();
      const replacement = profiles.create({
        name: "Reusable",
        email: "new@example.com"
      });
      expect(replacement.id).toBe(deleted.id);
      isolatedDb.prepare(
        `INSERT INTO repos (id, profile_id, name, path, source)
         VALUES ('replacement-repo', ?, 'Replacement', '/replacement', 'scan')`
      ).run(replacement.id);

      resume();
      await expect(scan).rejects.toMatchObject({ name: "AbortError" });
      expect(
        isolatedDb.prepare("SELECT id FROM repos WHERE id = 'replacement-repo'").get()
      ).toEqual({ id: "replacement-repo" });
      expect(
        isolatedDb
          .prepare("SELECT 1 FROM profile_scan_state WHERE profile_id = ?")
          .get(replacement.id)
      ).toBeUndefined();
    } finally {
      isolatedDb.close();
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  it("hydrates remote-only search entries for every persisted repo", async () => {
    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const first = profiles.create({
      name: "First",
      email: "first@example.com",
      roots: []
    });
    const second = profiles.create({
      name: "Second",
      email: "second@example.com",
      roots: []
    });
    let yields = 0;
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit, {
      branchWriteChunkSize: 1,
      yieldToEventLoop: async () => {
        yields += 1;
      }
    });
    const repoPaths = [first, second].map((profile, index) => {
      const container = mkdtempSync(join(tmpdir(), `pwrgit-hydrate-${index}-`));
      const repoPath = join(container, `manual-${index}`);
      const remotePath = join(container, `remote-${index}.git`);
      initRepo(repoPath);
      git(container, ["init", "--bare", `remote-${index}.git`]);
      git(repoPath, ["remote", "add", "origin", remotePath]);
      git(repoPath, ["branch", `releases/${index}.0`]);
      git(repoPath, ["push", "origin", `releases/${index}.0`]);
      git(repoPath, ["branch", "-D", `releases/${index}.0`]);
      return { profile, repoPath, branch: `releases/${index}.0` };
    });
    for (const entry of repoPaths) {
      const indexed = await isolatedIndexer.indexRepoAt(
        entry.profile.id,
        entry.repoPath
      );
      expect(indexed.ok).toBe(true);
    }
    isolatedDb
      .prepare("UPDATE repos SET source = 'scan' WHERE profile_id = ?")
      .run(first.id);

    // Simulate the just-upgraded database: persisted repos exist, while the
    // new derived remote-branch table starts empty.
    isolatedDb.prepare("DELETE FROM remote_branch_index_state").run();
    isolatedDb.prepare("DELETE FROM remote_branches").run();
    expect(isolatedIndexer.searchAll("releases")).toHaveLength(0);
    yields = 0;

    const background = await isolatedIndexer.hydrateRemoteBranches({
      excludeScannedProfileId: first.id
    });

    expect(background).toEqual({ refreshed: 1, failed: 0 });
    expect(
      isolatedIndexer
        .searchAll("releases/0.0")
        .some((hit) => hit.name === "releases/0.0")
    ).toBe(false);
    expect(isolatedIndexer.searchAll("releases/1.0")).toContainEqual(
      expect.objectContaining({
        kind: "remote_branch",
        profileId: second.id,
        name: "releases/1.0"
      })
    );

    expect(await isolatedIndexer.hydrateRemoteBranches()).toEqual({
      refreshed: 1,
      failed: 0
    });
    for (const entry of repoPaths) {
      expect(isolatedIndexer.searchAll(entry.branch)).toContainEqual(
        expect.objectContaining({
          kind: "remote_branch",
          profileId: entry.profile.id,
          name: entry.branch
        })
      );
    }
    expect(yields).toBeGreaterThan(0);

    // Startup backfill is migration repair, not routine maintenance. Once a
    // repository has been attempted, the next launch must do no Git work for
    // it; ordinary rescans and remote mutations keep the index current.
    expect(await isolatedIndexer.hydrateRemoteBranches()).toEqual({
      refreshed: 0,
      failed: 0
    });
  });

  it("hydrates active-profile manual repos while its scanned repos rescan", async () => {
    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Mixed",
      email: "mixed@example.com",
      roots: []
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    const repos = ["scanned", "manual"].map((name) => {
      const container = mkdtempSync(join(tmpdir(), `pwrgit-mixed-${name}-`));
      const repoPath = join(container, name);
      const remotePath = join(container, `${name}.git`);
      initRepo(repoPath);
      git(container, ["init", "--bare", `${name}.git`]);
      git(repoPath, ["remote", "add", "origin", remotePath]);
      git(repoPath, ["branch", "releases/1.0"]);
      git(repoPath, ["push", "origin", "releases/1.0"]);
      git(repoPath, ["branch", "-D", "releases/1.0"]);
      return { name, repoPath };
    });
    for (const repo of repos) {
      expect(
        (await isolatedIndexer.indexRepoAt(profile.id, repo.repoPath)).ok
      ).toBe(true);
    }
    isolatedDb
      .prepare("UPDATE repos SET source = 'scan' WHERE name = 'scanned'")
      .run();
    isolatedDb.prepare("DELETE FROM remote_branch_index_state").run();
    isolatedDb.prepare("DELETE FROM remote_branches").run();

    const hydrated = await isolatedIndexer.hydrateRemoteBranches({
      excludeScannedProfileId: profile.id
    });

    expect(hydrated).toEqual({ refreshed: 1, failed: 0 });
    const hits = isolatedIndexer.searchAll("releases/1.0");
    expect(hits.some((hit) => hit.repoName === "manual")).toBe(true);
    expect(hits.some((hit) => hit.repoName === "scanned")).toBe(false);
  });

  it("retries unavailable manual-repo hydration on a bounded schedule", async () => {
    const container = mkdtempSync(join(tmpdir(), "pwrgit-retry-hydrate-"));
    const repoPath = join(container, "manual");
    const unavailablePath = join(container, "manual-unavailable");
    const remotePath = join(container, "remote.git");
    initRepo(repoPath);
    git(container, ["init", "--bare", "remote.git"]);
    git(repoPath, ["remote", "add", "origin", remotePath]);
    git(repoPath, ["branch", "releases/1.0"]);
    git(repoPath, ["push", "origin", "releases/1.0"]);
    git(repoPath, ["branch", "-D", "releases/1.0"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Retry",
      email: "retry@example.com",
      roots: []
    });
    let now = 1_000;
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit, {
      hydrationRetryIntervalMs: 100,
      now: () => now
    });
    expect((await isolatedIndexer.indexRepoAt(profile.id, repoPath)).ok).toBe(
      true
    );
    isolatedDb.prepare("DELETE FROM remote_branch_index_state").run();
    isolatedDb.prepare("DELETE FROM remote_branches").run();

    renameSync(repoPath, unavailablePath);
    try {
      expect(await isolatedIndexer.hydrateRemoteBranches()).toEqual({
        refreshed: 0,
        failed: 1
      });
      expect(
        isolatedDb
          .prepare("SELECT COUNT(*) AS n FROM remote_branch_index_state")
          .get()
      ).toEqual({ n: 0 });
      expect(await isolatedIndexer.hydrateRemoteBranches()).toEqual({
        refreshed: 0,
        failed: 0
      });
    } finally {
      renameSync(unavailablePath, repoPath);
    }

    now += 100;
    expect(await isolatedIndexer.hydrateRemoteBranches()).toEqual({
      refreshed: 1,
      failed: 0
    });
    expect(
      isolatedIndexer
        .searchAll("releases/1.0")
        .some((hit) => hit.repoName === "manual")
    ).toBe(true);
    expect(
      isolatedDb
        .prepare("SELECT COUNT(*) AS n FROM remote_branch_hydration_retry")
        .get()
    ).toEqual({ n: 0 });
  });

  it("matches slash-containing configured remote names by longest prefix", async () => {
    const container = mkdtempSync(join(tmpdir(), "pwrgit-slash-remote-"));
    const repoPath = join(container, "slash-remote");
    const remotePath = join(container, "remote.git");
    initRepo(repoPath);
    git(container, ["init", "--bare", "remote.git"]);
    git(repoPath, ["remote", "add", "team/foo", remotePath]);
    git(repoPath, ["branch", "release"]);
    git(repoPath, ["push", "team/foo", "release"]);
    git(repoPath, ["branch", "-D", "release"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Slash",
      email: "slash@example.com",
      roots: []
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    expect(
      (await isolatedIndexer.indexRepoAt(profile.id, repoPath)).ok
    ).toBe(true);

    expect(isolatedIndexer.searchAll("release")).toContainEqual(
      expect.objectContaining({
        kind: "remote_branch",
        name: "release",
        remoteName: "team/foo",
        remoteRef: "refs/remotes/team/foo/release"
      })
    );
  });

  // A worktree keeps the directory name it was created with; renaming its
  // branch leaves the directory as the only name that still matches what the
  // user's shell shows them. Both names then exist as separate index rows — the
  // discarded branch under its old name, the checkout under its new one — and
  // the query hit them in the wrong order: the branch matched a `name` column
  // (bm25 weight 10) and the checkout only its tokenized path (weight 2), so
  // the bare ref, which is checked out nowhere, came first.
  it("ranks a checkout above the discarded branch its folder is named after", async () => {
    const container = mkdtempSync(join(tmpdir(), "pwrgit-folder-rank-"));
    const repoPath = join(container, "snapfarm");
    initRepo(repoPath);
    const wtPath = join(container, "recursing-euler-9edf74");
    git(repoPath, ["worktree", "add", wtPath, "-b", "recursing-euler-9edf74"]);
    // The rename Claude-style tooling performs after creating the worktree.
    git(wtPath, ["branch", "-m", "dmg-file-art-update-4fd193"]);
    // …and the discarded branch it leaves behind, checked out nowhere.
    git(repoPath, ["branch", "recursing-euler-9edf74"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Folders",
      email: "folders@example.com",
      roots: []
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    expect((await isolatedIndexer.indexRepoAt(profile.id, repoPath)).ok).toBe(
      true
    );

    // Typed as much as the shell prompt shows, and typed in full.
    for (const query of ["recursing", "recursing-euler-9edf74"]) {
      const hits = isolatedIndexer
        .searchAll(query)
        .filter((hit) => hit.kind === "worktree" || hit.kind === "local_branch");
      // Asserted by branch, not by path: git reports its own normalization of
      // a worktree path (on macOS the /private realpath of a temp dir), so a
      // path rebuilt here with node:path would not compare equal.
      expect(hits[0]).toMatchObject({
        kind: "worktree",
        name: "dmg-file-art-update-4fd193"
      });
      expect(hits[1]).toMatchObject({
        kind: "local_branch",
        name: "recursing-euler-9edf74"
      });
    }

    // The branch is still the stronger answer where it is the one named: its
    // own name beats a folder that merely starts with the query.
    expect(
      isolatedIndexer.searchAll("dmg-file-art-update-4fd193")[0]
    ).toMatchObject({ kind: "worktree", name: "dmg-file-art-update-4fd193" });
  });

  it("indexes discovered repos, deduping linked worktrees into their repo", async () => {
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    const repos = await indexer.rescanProfile(profile);

    // repoA (+ its linked worktree) and repoB — two repos, not three.
    expect(repos).toHaveLength(2);
    const repoA = repos.find((r) => r.name === "repoA");
    expect(repoA).toBeDefined();
    const branches = repoA?.worktrees.map((w) => w.branch).sort();
    expect(branches).toEqual(["feature", "main"]);
    expect(repoA?.worktrees.find((w) => w.isPrimary)?.branch).toBe("main");
  });

  it("carries hover-card detail onto a worktree's PR, not just the number", async () => {
    // Regression: the sidebar join projected only number/url/title/state/
    // is_draft, so the PR hover card could never show Changes or Timeline no
    // matter what the cache held.
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    const repos = await indexer.rescanProfile(profile);
    const repoA = repos.find((r) => r.name === "repoA");
    if (repoA === undefined) throw new Error("repoA missing");

    db.prepare(
      `INSERT INTO branch_pr
         (repo_id, branch, number, url, title, state, is_draft,
          forge, host, repo_path, head_ref, base_ref,
          additions, deletions, changed_files, commit_count, opened_at, merged_at)
       VALUES (?, 'feature', 4242, 'https://x', 'Detailed', 'merged', 0,
          'gitlab', 'gitlab.com', 'g/s/p', 'feature', 'main',
          12, 5, 3, 2, 1000, 2000)`
    ).run(repoA.id);
    db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, is_draft)
       VALUES (?, 'main', 7, 'https://y', 'Bare', 'open', 0)`
    ).run(repoA.id);

    const worktrees = indexer
      .listRepos(profileId)
      .find((candidate) => candidate.id === repoA.id)?.worktrees;

    expect(worktrees?.find((w) => w.branch === "feature")?.pr).toMatchObject({
      number: 4242,
      state: "merged",
      forge: "gitlab",
      host: "gitlab.com",
      repoPath: "g/s/p",
      headRefName: "feature",
      baseRefName: "main",
      additions: 12,
      deletions: 5,
      changedFiles: 3,
      commitCount: 2,
      createdAt: 1000,
      mergedAt: 2000
    });

    // A row with no detail keeps it absent rather than reporting zero.
    const bare = worktrees?.find((w) => w.branch === "main")?.pr;
    expect(bare?.number).toBe(7);
    for (const key of ["additions", "changedFiles", "commitCount", "createdAt"]) {
      expect(bare).not.toHaveProperty(key);
    }

    db.prepare("DELETE FROM branch_pr WHERE repo_id = ?").run(repoA.id);
  });

  it("persists a hand-arranged repo order and survives a rescan", async () => {
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    const repos = await indexer.rescanProfile(profile);
    // Name order puts repoA first; arranging inverts that.
    expect(repos.map((r) => r.name)).toEqual(["repoA", "repoB"]);
    const byName = new Map(repos.map((r) => [r.name, r.id]));
    const a = byName.get("repoA");
    const b = byName.get("repoB");
    if (a === undefined || b === undefined) throw new Error("repos missing");

    indexer.setRepoOrder(profileId, [b, a]);
    expect(indexer.listRepos(profileId).map((r) => r.name)).toEqual([
      "repoB",
      "repoA"
    ]);
    expect(indexer.getRepo(b)?.order).toBe(0);
    expect(indexer.getRepo(a)?.order).toBe(1);

    // A rescan touches identity, not the arrangement.
    const rescanned = await indexer.rescanProfile(profile);
    expect(rescanned.map((r) => r.name)).toEqual(["repoB", "repoA"]);

    // Reset so the ordering doesn't leak into the sibling tests below.
    db.prepare("UPDATE repos SET custom_order = NULL").run();
  });

  it("unpinning clears the manual order so a re-pin isn't placed arbitrarily", async () => {
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    const repos = await indexer.rescanProfile(profile);
    const byName = new Map(repos.map((r) => [r.name, r.id]));
    const a = byName.get("repoA");
    const b = byName.get("repoB");
    if (a === undefined || b === undefined) throw new Error("repos missing");

    indexer.setRepoPinned(a, true);
    indexer.setRepoPinned(b, true);
    indexer.setRepoOrder(profileId, [b, a]);
    expect(indexer.getRepo(a)?.order).toBe(1);

    // Unpin A, then rearrange what's left. Without the clear, A would keep
    // index 1 while B takes index 0 — and re-pinning A would collide with
    // whatever now holds 1, dropping it somewhere the user never chose.
    indexer.setRepoPinned(a, false);
    expect(indexer.getRepo(a)?.order).toBeUndefined();

    indexer.setRepoOrder(profileId, [b]);
    indexer.setRepoPinned(a, true);
    expect(indexer.getRepo(a)?.order).toBeUndefined();
    expect(indexer.getRepo(b)?.order).toBe(0);

    db.prepare("UPDATE repos SET custom_order = NULL, pinned = 0").run();
  });

  it("leaves unarranged repos unordered and sorted by name", async () => {
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    const repos = await indexer.rescanProfile(profile);
    for (const r of repos) expect(r.order).toBeUndefined();
    expect(repos.map((r) => r.name)).toEqual(["repoA", "repoB"]);
  });

  it("is idempotent across rescans (no duplicate rows)", async () => {
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    await indexer.rescanProfile(profile);
    const repos = await indexer.rescanProfile(profile);
    expect(repos).toHaveLength(2);
  });

  it("manual-add indexes a repo outside the roots and search finds it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pwrgit-manual-"));
    const manualRepo = join(outside, "solo");
    initRepo(manualRepo);

    const added = await indexer.indexRepoAt(profileId, manualRepo);
    expect(added.ok).toBe(true);

    const hits = indexer.searchAll("solo");
    expect(hits.some((h) => h.name === "solo")).toBe(true);

    // A subsequent root rescan must not prune the manually-added repo.
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    await indexer.rescanProfile(profile);
    expect(indexer.searchAll("solo").some((h) => h.name === "solo")).toBe(true);
  });

  it("keeps scanned repos and their arrangement when a root is unreadable", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pwrgit-unmounted-"));
    const isolatedRoot = join(parent, "volume");
    const detachedRoot = join(parent, "volume-detached");
    initRepo(join(isolatedRoot, "repo"));

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Unmounted",
      email: "unmounted@example.com",
      roots: [isolatedRoot]
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);

    const indexed = (await isolatedIndexer.rescanProfile(profile))[0];
    if (indexed === undefined) throw new Error("repo missing");
    isolatedIndexer.setRepoPinned(indexed.id, true);
    isolatedIndexer.setRepoOrder(profile.id, [indexed.id]);

    // Stand in for an external volume, or a share not mounted yet at login:
    // the root stops resolving, discovery's readdir throws, and the scan comes
    // back with nothing. That is a scan that looked nowhere, not one that
    // found the repos gone — pruning on it would take the row and everything
    // cascading from it.
    renameSync(isolatedRoot, detachedRoot);
    try {
      const whileDetached = await isolatedIndexer.rescanProfile(profile);
      expect(whileDetached.map((r) => r.name)).toEqual(["repo"]);
    } finally {
      renameSync(detachedRoot, isolatedRoot);
    }

    // Remounted, and it is the same row throughout: the pin and the
    // hand-placed order survived. Re-inserting under the same hashed id would
    // have rebuilt neither.
    const remounted = await isolatedIndexer.rescanProfile(profile);
    expect(remounted.map((r) => r.name)).toEqual(["repo"]);
    expect(isolatedIndexer.getRepo(indexed.id)?.pinned).toBe(true);
    expect(isolatedIndexer.getRepo(indexed.id)?.order).toBe(0);
  });

  it("keeps scanned repos when a readable root resolves none at all", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pwrgit-empty-scan-"));
    const isolatedRoot = join(parent, "root");
    const repoPath = join(isolatedRoot, "repo");
    const movedPath = join(parent, "repo-elsewhere");
    initRepo(repoPath);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Empty",
      email: "empty@example.com",
      roots: [isolatedRoot]
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    expect(await isolatedIndexer.rescanProfile(profile)).toHaveLength(1);

    // The root itself lists fine here — an empty mount point standing in for
    // the share, or a git that failed for every candidate, reads exactly like
    // this. Emptying a profile wholesale needs better evidence than a scan
    // that resolved nothing.
    renameSync(repoPath, movedPath);
    try {
      const emptied = await isolatedIndexer.rescanProfile(profile);
      expect(emptied.map((r) => r.name)).toEqual(["repo"]);
    } finally {
      renameSync(movedPath, repoPath);
    }
  });

  it("still prunes a repo that vanished from a readable root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pwrgit-prune-"));
    const isolatedRoot = join(parent, "root");
    const goingPath = join(isolatedRoot, "going");
    const movedPath = join(parent, "going-elsewhere");
    initRepo(join(isolatedRoot, "staying"));
    initRepo(goingPath);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Prune",
      email: "prune@example.com",
      roots: [isolatedRoot]
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    expect(
      (await isolatedIndexer.rescanProfile(profile)).map((r) => r.name)
    ).toEqual(["going", "staying"]);

    // The scan still resolved a repo, so it saw the root's contents and can be
    // believed about what is no longer there.
    renameSync(goingPath, movedPath);
    const pruned = await isolatedIndexer.rescanProfile(profile);
    expect(pruned.map((r) => r.name)).toEqual(["staying"]);
  });

  it("suppresses the prune for every root while any one is unreadable", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pwrgit-two-roots-"));
    const healthyRoot = join(parent, "healthy");
    const detachableRoot = join(parent, "detachable");
    const detachedRoot = join(parent, "detachable-gone");
    const goingPath = join(healthyRoot, "going");
    const movedPath = join(parent, "going-elsewhere");
    initRepo(join(healthyRoot, "staying"));
    initRepo(goingPath);
    initRepo(join(detachableRoot, "onvolume"));

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Two roots",
      email: "tworoots@example.com",
      roots: [healthyRoot, detachableRoot]
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    expect(
      (await isolatedIndexer.rescanProfile(profile)).map((r) => r.name)
    ).toEqual(["going", "onvolume", "staying"]);

    // One root detaches while a repo is genuinely deleted from the OTHER,
    // perfectly readable root. The flag is profile-wide deliberately: scoping
    // the prune per root would mean matching git-normalised repo paths against
    // configured root strings, and on Windows those come from different sources
    // with different separators — a false negative there is the data loss this
    // guard exists to prevent. So `going` lingers rather than risking that.
    renameSync(detachableRoot, detachedRoot);
    renameSync(goingPath, movedPath);
    try {
      expect(
        (await isolatedIndexer.rescanProfile(profile)).map((r) => r.name)
      ).toEqual(["going", "onvolume", "staying"]);
    } finally {
      renameSync(detachedRoot, detachableRoot);
    }

    // Every root readable again, so the scan is believed and the backlog
    // clears: only the repo that really went away is dropped.
    expect(
      (await isolatedIndexer.rescanProfile(profile)).map((r) => r.name)
    ).toEqual(["onvolume", "staying"]);
  });

  it("stamps the scan clock only when every root could be listed", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pwrgit-scan-clock-"));
    const isolatedRoot = join(parent, "volume");
    const detachedRoot = join(parent, "volume-detached");
    const emptyRoot = mkdtempSync(join(tmpdir(), "pwrgit-scan-clock-empty-"));
    initRepo(join(isolatedRoot, "repo"));

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Clock",
      email: "clock@example.com",
      roots: [isolatedRoot]
    });
    let now = 1_000;
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit, {
      profileRescanIntervalMs: 10_000,
      now: () => now
    });
    await isolatedIndexer.rescanProfile(profile);
    expect(isolatedIndexer.shouldRescanProfile(profile.id)).toBe(false);

    // A scan that could not list its root never completed a pass, so it must
    // not arm the throttle. Stamping it would leave a volume mounted a minute
    // later undiscovered for a day — and there is no manual rescan channel to
    // fall back on, only editing the roots list.
    renameSync(isolatedRoot, detachedRoot);
    try {
      now += 20_000;
      await isolatedIndexer.rescanProfile(profile);
      expect(
        isolatedDb
          .prepare(
            "SELECT scanned_at_ms FROM profile_scan_state WHERE profile_id = ?"
          )
          .get(profile.id)
      ).toEqual({ scanned_at_ms: 1_000 });
      expect(isolatedIndexer.shouldRescanProfile(profile.id)).toBe(true);
    } finally {
      renameSync(detachedRoot, isolatedRoot);
    }

    // A root that reads fine but holds no repos DID complete a pass. It refuses
    // to prune on that, but it still stamps — otherwise a legitimately empty
    // root would re-walk on every profile open.
    const emptied = profiles.setRoots(profile.id, [emptyRoot]);
    if (emptied === null) throw new Error("profile missing");
    now += 20_000;
    await isolatedIndexer.rescanProfile(emptied);
    expect(isolatedIndexer.shouldRescanProfile(profile.id)).toBe(false);
  });

  it("prunes every scanned repo once the last root is removed", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pwrgit-no-roots-"));
    initRepo(join(isolatedRoot, "repo"));

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "No roots",
      email: "noroots@example.com",
      roots: [isolatedRoot]
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    expect(await isolatedIndexer.rescanProfile(profile)).toHaveLength(1);

    // Clearing the roots is the one deliberate way to reach zero, and it must
    // still prune — `setRoots` promises repos under a removed root go away.
    const rootless = profiles.setRoots(profile.id, []);
    if (rootless === null) throw new Error("profile missing");
    expect(await isolatedIndexer.rescanProfile(rootless)).toHaveLength(0);
  });

  it("rejects a non-repo path", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "pwrgit-notrepo-"));
    const result = await indexer.indexRepoAt(profileId, notRepo);
    expect(result.ok).toBe(false);
  });

  it("reconciles external worktree additions, removals, and branch switches", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pwrgit-refresh-"));
    const repoPath = join(isolatedRoot, "repo");
    const linkedPath = join(isolatedRoot, "linked");
    const addedPath = join(isolatedRoot, "added");
    initRepo(repoPath);
    git(repoPath, ["worktree", "add", linkedPath, "-b", "feature"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Refresh",
      email: "refresh@example.com",
      roots: [isolatedRoot]
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    const indexed = (await isolatedIndexer.rescanProfile(profile)).find(
      (repo) => repo.name === "repo"
    );
    if (indexed === undefined) throw new Error("repo missing");

    const originalLinked = indexed.worktrees.find(
      (w) => w.branch === "feature"
    );
    if (originalLinked === undefined) throw new Error("linked worktree missing");
    isolatedIndexer.setWorktreePinned(originalLinked.id, true);
    isolatedIndexer.setWorktreeOrder(indexed.id, [originalLinked.id]);

    // These changes happen outside PwrGit. The cached index and search remain
    // stale until this repo is explicitly reconciled.
    git(linkedPath, ["switch", "-c", "feat/messaging-rbac-permissions"]);
    git(repoPath, ["worktree", "add", addedPath, "-b", "external-added"]);
    expect(isolatedIndexer.searchAll("rbac")).toHaveLength(0);
    expect(isolatedIndexer.searchAll("external-added")).toHaveLength(0);

    const first = await isolatedIndexer.refreshRepoWorktrees(indexed.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.outcome).toBe("reconciled");
    if (first.value.outcome !== "reconciled") return;
    expect(first.value.added).toBe(1);
    expect(first.value.removed).toBe(0);
    expect(first.value.updated).toBe(1);
    expect(
      isolatedIndexer
        .searchAll("rbac")
        .some((h) => h.name === "feat/messaging-rbac-permissions")
    ).toBe(true);
    expect(
      isolatedIndexer
        .searchAll("external-added")
        .some((h) => h.name === "external-added")
    ).toBe(true);

    const retained = first.value.repo.worktrees.find(
      (w) => w.id === originalLinked.id
    );
    expect(retained?.pinned).toBe(true);
    expect(retained?.order).toBe(0);

    git(repoPath, ["worktree", "remove", addedPath]);
    const second = await isolatedIndexer.refreshRepoWorktrees(indexed.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toMatchObject({
      outcome: "reconciled",
      added: 0,
      removed: 1,
      updated: 0
    });
    // Removing a worktree does not delete its branch, so the branch stays
    // findable — as a local branch with nothing checked out on it (0022).
    const orphaned = isolatedIndexer.searchAll("external-added");
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toMatchObject({
      kind: "local_branch",
      name: "external-added"
    });
  });

  it("reports dropping a fossil repo row as a success, not a failure", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pwrgit-fossil-"));
    const repoPath = join(isolatedRoot, "repo");
    const linkedPath = join(isolatedRoot, "linked");
    initRepo(repoPath);
    git(repoPath, ["worktree", "add", linkedPath, "-b", "feature"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Fossil",
      email: "fossil@example.com",
      roots: [isolatedRoot]
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    const canonical = (await isolatedIndexer.rescanProfile(profile)).find(
      (repo) => repo.name === "repo"
    );
    if (canonical === undefined) throw new Error("canonical repo missing");

    // Older builds could index a LINKED worktree dir as a repo in its own
    // right; discovery canonicalises now, so forge the legacy row directly.
    // 'manual' because pruneScannedRepos would drop a stale 'scan' row at the
    // next startup rescan — only manual rows survive to reach this path.
    isolatedDb
      .prepare(
        `INSERT INTO repos (id, profile_id, name, path, source)
         VALUES (?, ?, ?, ?, 'manual')`
      )
      .run("fossil", profile.id, "fossilrow", linkedPath);
    expect(isolatedIndexer.getRepo("fossil")).not.toBeNull();
    expect(isolatedIndexer.searchAll("fossilrow")).not.toHaveLength(0);

    const result = await isolatedIndexer.refreshRepoWorktrees("fossil");

    // Dropping the row is what SHOULD happen — that worktree belongs to the
    // canonical repo. Reporting it as an error makes the UI tell the user the
    // refresh failed while they watch it visibly succeed.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Compare against the indexed repo's path, not a locally joined one: git
    // reports its own normalisation (POSIX separators on Windows, /private/var
    // for macOS temp dirs, long names rather than 8.3), which no amount of
    // node:path/realpathSync reconstruction reliably reproduces.
    expect(result.value).toEqual({
      outcome: "deindexed",
      profileId: profile.id,
      ownerPath: canonical.path
    });
    expect(isolatedIndexer.getRepo("fossil")).toBeNull();

    // The delete goes through raw SQL, so ⌘F only stays correct as long as the
    // FTS triggers (and the worktree cascade behind them) keep firing.
    expect(isolatedIndexer.searchAll("fossilrow")).toHaveLength(0);
    // The canonical repo keeps its own rows — the fossil's cleanup is scoped.
    expect(isolatedIndexer.getRepo(canonical.id)?.worktrees).toHaveLength(2);
  });
});

describe("searchAll (FTS5)", () => {
  it("indexes fetched remote-only branches and prunes deleted tracking refs", async () => {
    const repoPath = join(root, "repoA");
    const remoteRoot = mkdtempSync(join(tmpdir(), "pwrgit-search-remote-"));
    const remotePath = join(remoteRoot, "repoA.git");
    git(remoteRoot, ["init", "--bare", "repoA.git"]);
    git(repoPath, ["remote", "add", "origin", remotePath]);
    git(repoPath, ["branch", "releases/1.0"]);
    git(repoPath, ["push", "origin", "releases/1.0"]);
    git(repoPath, ["branch", "-D", "releases/1.0"]);

    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    const repo = (await indexer.rescanProfile(profile)).find(
      (candidate) => candidate.name === "repoA"
    );
    if (repo === undefined) throw new Error("repoA missing");

    expect(indexer.searchAll("releases 1.0")).toContainEqual(
      expect.objectContaining({
        kind: "remote_branch",
        repoId: repo.id,
        repoName: "repoA",
        name: "releases/1.0",
        remoteName: "origin",
        remoteRef: "refs/remotes/origin/releases/1.0"
      })
    );

    git(repoPath, ["update-ref", "-d", "refs/remotes/origin/releases/1.0"]);
    await indexer.refreshRepoWorktrees(repo.id);
    expect(indexer.searchAll("releases 1.0")).toHaveLength(0);
  });

  // Local branches were in none of the indexed kinds before 0022, so a branch
  // created without a checkout was unreachable from ⌘K. Its own isolated repo:
  // the shared `root` fixture is asserted on by name/branch across this file.
  it("indexes local branches with no worktree, and hands them back on checkout", async () => {
    const container = mkdtempSync(join(tmpdir(), "pwrgit-local-branch-"));
    const repoPath = join(container, "solo");
    initRepo(repoPath);
    git(repoPath, ["branch", "spike/no-checkout"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Local",
      email: "local@example.com",
      roots: []
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    const indexed = await isolatedIndexer.indexRepoAt(profile.id, repoPath);
    expect(indexed.ok).toBe(true);
    if (!indexed.ok) return;
    const repoId = indexed.value.id;

    expect(isolatedIndexer.searchAll("spike no-checkout")).toContainEqual(
      expect.objectContaining({
        kind: "local_branch",
        repoId,
        repoName: "solo",
        name: "spike/no-checkout",
        worktreeCount: 0,
        pinned: false
      })
    );

    // "main" IS checked out, so it stays a worktree hit only — indexing it here
    // too would put the same branch in the palette twice.
    const mainHits = isolatedIndexer.searchAll("main");
    expect(mainHits.some((hit) => hit.kind === "worktree")).toBe(true);
    expect(mainHits.some((hit) => hit.kind === "local_branch")).toBe(false);

    // Giving the branch a worktree moves it between kinds — one hit throughout.
    const wtPath = join(container, "solo-spike");
    git(repoPath, ["worktree", "add", wtPath, "spike/no-checkout"]);
    expect((await isolatedIndexer.refreshRepoWorktrees(repoId)).ok).toBe(true);
    const afterCheckout = isolatedIndexer.searchAll("spike no-checkout");
    expect(afterCheckout).toHaveLength(1);
    expect(afterCheckout[0]?.kind).toBe("worktree");
    expect(afterCheckout[0]?.worktreeId).toBeDefined();
  });

  it("prunes local-branch rows once the branch is gone", async () => {
    const container = mkdtempSync(join(tmpdir(), "pwrgit-local-prune-"));
    const repoPath = join(container, "pruner");
    initRepo(repoPath);
    git(repoPath, ["branch", "throwaway/idea"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Prune",
      email: "prune@example.com",
      roots: []
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit, {
      branchWriteChunkSize: 1
    });
    const indexed = await isolatedIndexer.indexRepoAt(profile.id, repoPath);
    expect(indexed.ok).toBe(true);
    if (!indexed.ok) return;

    expect(isolatedIndexer.searchAll("throwaway idea")).toHaveLength(1);
    git(repoPath, ["branch", "-D", "throwaway/idea"]);
    expect(
      (await isolatedIndexer.refreshRepoRemoteBranches(indexed.value.id)).ok
    ).toBe(true);
    expect(isolatedIndexer.searchAll("throwaway idea")).toHaveLength(0);
  });

  // 0022 clears the 0020 completion markers so the existing one-time backfill
  // fills the new table too; without that an upgraded database would show no
  // local branches until a daily rescan happened to come round.
  it("backfills local branches through the branch-index hydration pass", async () => {
    const container = mkdtempSync(join(tmpdir(), "pwrgit-local-hydrate-"));
    const repoPath = join(container, "upgraded");
    initRepo(repoPath);
    git(repoPath, ["branch", "carried/over"]);

    const isolatedDb = openDatabase(":memory:");
    const profiles = new ProfileService(isolatedDb);
    const profile = profiles.create({
      name: "Upgrade",
      email: "upgrade@example.com",
      roots: []
    });
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
    expect((await isolatedIndexer.indexRepoAt(profile.id, repoPath)).ok).toBe(
      true
    );
    isolatedDb.prepare("DELETE FROM remote_branch_index_state").run();
    isolatedDb.prepare("DELETE FROM local_branches").run();
    expect(isolatedIndexer.searchAll("carried over")).toHaveLength(0);

    expect(await isolatedIndexer.hydrateRemoteBranches()).toEqual({
      refreshed: 1,
      failed: 0
    });
    expect(isolatedIndexer.searchAll("carried over")).toContainEqual(
      expect.objectContaining({ kind: "local_branch", name: "carried/over" })
    );
  });

  it("finds worktrees by branch prefix, with repo context", async () => {
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    await indexer.rescanProfile(profile);

    const hits = indexer.searchAll("feat");
    const wt = hits.find((h) => h.kind === "worktree" && h.name === "feature");
    expect(wt).toBeDefined();
    expect(wt?.repoName).toBe("repoA");
    expect(wt?.worktreeId).toBeDefined();
  });

  it("ANDs tokens across fields (branch + owning repo name)", () => {
    // Both tokens must land on the same row: branch "feature" + repo_name
    // "repoA" — the old LIKE implementation could never express this.
    const hits = indexer.searchAll("repoa feat");
    expect(
      hits.some((h) => h.kind === "worktree" && h.name === "feature")
    ).toBe(true);
    // Junk that matches nothing returns empty, not everything.
    expect(indexer.searchAll("repoa zzznosuch")).toHaveLength(0);
  });

  it("ranks name matches above path matches", () => {
    // "repoA" appears in repoA's NAME and in its worktree's PATH (…/repoA-wt),
    // so both rows match — the name hit must outrank the path hit.
    const hits = indexer.searchAll("repoA");
    expect(hits[0]?.kind).toBe("repo");
    expect(hits[0]?.name).toBe("repoA");
  });

  it("ranks an exact branch name above stronger fuzzy term-frequency matches", () => {
    const repo = db
      .prepare("SELECT id FROM repos WHERE name = 'repoA'")
      .get() as { id: string };
    const insert = db.prepare(
      `INSERT INTO remote_branches (id, repo_id, name, full_name, remote_name)
       VALUES (?, ?, ?, ?, 'origin')`
    );
    // Repeating every query token gives this row a stronger raw bm25 score.
    // The literal branch-name match is still the user's clear intent.
    for (let index = 0; index < 65; index += 1) {
      insert.run(
        `remote-noisy-release-${index}`,
        repo.id,
        `releases/1.0-releases-1.0-noise-${index}`,
        `refs/remotes/origin/releases/1.0-releases-1.0-noise-${index}`
      );
    }
    insert.run(
      "remote-exact-release",
      repo.id,
      "releases/1.0",
      "refs/remotes/origin/releases/1.0"
    );

    const releaseHits = indexer
      .searchAll("releases/1.0")
      .filter((hit) => hit.kind === "remote_branch");

    expect(releaseHits[0]?.name).toBe("releases/1.0");
  });

  it("falls back to browsing repos on an empty or junk query", () => {
    const empty = indexer.searchAll("");
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.every((h) => h.kind === "repo")).toBe(true);
    expect(indexer.searchAll("/-·")).toEqual(empty);
  });

  it("finds worktrees by PR number and PR title words", () => {
    // The PR association lives in branch_pr — typing "13029" (or title
    // words) must land on the worktree whose branch carries that PR.
    const repoRow = db
      .prepare("SELECT id FROM repos WHERE name = 'repoA'")
      .get() as { id: string };
    db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, is_draft)
       VALUES (?, 'feature', 13029, 'https://x', 'Migrate readonly channel routes', 'open', 0)
       ON CONFLICT(repo_id, branch) DO UPDATE SET
         number = excluded.number, title = excluded.title`
    ).run(repoRow.id);

    const byNumber = indexer.searchAll("13029");
    const hit = byNumber.find(
      (h) => h.kind === "worktree" && h.name === "feature"
    );
    expect(hit).toBeDefined();
    // The hit carries the PR itself, so the overlay can wear the chip.
    expect(hit?.pr?.number).toBe(13029);
    expect(hit?.pr?.state).toBe("open");

    const byTitle = indexer.searchAll("readonly channel");
    expect(
      byTitle.some((h) => h.kind === "worktree" && h.name === "feature")
    ).toBe(true);

    // Negative cache ("checked, no PR") clears the searchable text.
    db.prepare(
      `UPDATE branch_pr SET number = NULL, title = NULL
       WHERE repo_id = ? AND branch = 'feature'`
    ).run(repoRow.id);
    expect(
      indexer
        .searchAll("13029")
        .some((h) => h.kind === "worktree" && h.name === "feature")
    ).toBe(false);
  });

  it("carries pin state on hits and browses pinned repos first", async () => {
    const profile = profileService.get(profileId);
    if (profile === null) throw new Error("profile missing");
    await indexer.rescanProfile(profile);

    const repoRow = db
      .prepare("SELECT id FROM repos WHERE name = 'repoB'")
      .get() as { id: string };
    const wtRow = db
      .prepare("SELECT id FROM worktrees WHERE branch = 'feature'")
      .get() as { id: string };
    indexer.setRepoPinned(repoRow.id, true);
    indexer.setWorktreePinned(wtRow.id, true);

    // Queried hits carry the flag on both kinds.
    const repoHit = indexer.searchAll("repoB").find((h) => h.kind === "repo");
    expect(repoHit?.pinned).toBe(true);
    const wtHit = indexer
      .searchAll("feature")
      .find((h) => h.kind === "worktree" && h.name === "feature");
    expect(wtHit?.pinned).toBe(true);
    const unpinned = indexer.searchAll("repoA").find((h) => h.kind === "repo");
    expect(unpinned?.pinned).toBe(false);

    // Empty-query browse floats pinned repos above the alphabetical rest.
    const browse = indexer.searchAll("");
    expect(browse[0]?.name).toBe("repoB");
    expect(browse[0]?.pinned).toBe(true);

    indexer.setRepoPinned(repoRow.id, false);
    indexer.setWorktreePinned(wtRow.id, false);
  });

  it("emits one hit per entity even when the FTS index holds duplicates", () => {
    // Fossil DBs (pre-PK worktree rows) can double-insert into search_fts via
    // the migration backfill. Duplicate hits become duplicate React keys in
    // the overlay → ghost rows that survive re-renders.
    const repoRow = db
      .prepare("SELECT id, name, path FROM repos WHERE name = 'repoA'")
      .get() as { id: string; name: string; path: string };
    db.prepare(
      `INSERT INTO search_fts (entity_id, kind, name, path, repo_name)
       VALUES (?, 'repo', ?, ?, NULL)`
    ).run(repoRow.id, repoRow.name, repoRow.path);

    const hits = indexer.searchAll("repoA");
    const repoHits = hits.filter(
      (h) => h.kind === "repo" && h.repoId === repoRow.id
    );
    expect(repoHits).toHaveLength(1);
  });
});
