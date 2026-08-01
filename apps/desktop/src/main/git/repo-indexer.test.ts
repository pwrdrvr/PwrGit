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
});

describe("searchAll (FTS5)", () => {
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
