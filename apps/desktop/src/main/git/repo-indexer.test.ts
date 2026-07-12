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

  const db = openDatabase(":memory:");
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
});
