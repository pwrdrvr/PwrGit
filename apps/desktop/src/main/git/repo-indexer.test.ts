import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec, GitOutput } from "./dugite";
import { findRepoDirs, RepoIndexer } from "./repo-indexer";

// Drive the indexer with system git so the test is independent of dugite's
// bundled binary.
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
});

describe("RepoIndexer", () => {
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
    const isolatedIndexer = new RepoIndexer(isolatedDb, systemGit);
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

    // Simulate the just-upgraded database: persisted repos exist, while the
    // new derived remote-branch table starts empty.
    isolatedDb.prepare("DELETE FROM remote_branches").run();
    expect(isolatedIndexer.searchAll("releases")).toHaveLength(0);

    const hydrated = await isolatedIndexer.hydrateRemoteBranches();

    expect(hydrated).toEqual({ refreshed: 2, failed: 0 });
    for (const entry of repoPaths) {
      expect(isolatedIndexer.searchAll(entry.branch)).toContainEqual(
        expect.objectContaining({
          kind: "remote_branch",
          profileId: entry.profile.id,
          name: entry.branch
        })
      );
    }
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
    expect(isolatedIndexer.searchAll("external-added")).toHaveLength(0);
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
