import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { err, ok, type LaneGraph, type Result } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import type { GitExec, GitOutput } from "./dugite";
import { RepoIndexer } from "./repo-indexer";
import { WorktreeStateService } from "./worktree-state";

// graph-handlers reaches for `execGit` directly rather than taking a GitExec,
// so the only way to drive it against a real repo is to swap the module. System
// git keeps the test independent of dugite's bundled binary, as elsewhere here.
const { systemGit } = vi.hoisted(() => ({
  systemGit: ((args: string[], cwd: string) =>
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
    })) satisfies GitExec
}));

vi.mock("./dugite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dugite")>();
  return { ...actual, execGit: systemGit };
});

const { registerGraphHandlers } = await import("./graph-handlers");

const EMAIL = "graph@example.com";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function commit(dir: string, name: string): string {
  writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", name]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
    .toString()
    .trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", EMAIL]);
  git(dir, ["config", "user.name", "Grapher"]);
  // Only ever compared as paths/hashes here, but the git suite runs on the
  // Windows CI runner where autocrlf would otherwise rewrite what we commit.
  git(dir, ["config", "core.autocrlf", "false"]);
}

/** A `branch_pr` row with every hover-card detail column populated. */
const DETAILED_PR = {
  number: 4242,
  url: "https://github.com/acme/app/pull/4242",
  title: "Teach the lane graph about PR detail",
  state: "open",
  is_draft: 0,
  forge: "github",
  host: "github.com",
  repo_path: "acme/app",
  head_ref: "feature",
  base_ref: "main",
  additions: 128,
  deletions: 37,
  changed_files: 9,
  commit_count: 4,
  opened_at: 1_700_000_000,
  merged_at: 1_700_090_000,
  closed_at: null
};

let db: ReturnType<typeof openDatabase>;
let bus: CommandBus;
let repoId: string;
let repoPath: string;
/** worktree id per branch, for addressing `graph:log` / `graph:lanes`. */
const worktreeIds = new Map<string, string>();
let mainTip: string;
let noprTip: string;

function insertPr(branch: string, row: Record<string, unknown>): void {
  const columns = ["repo_id", "branch", ...Object.keys(row)];
  db.prepare(
    `INSERT INTO branch_pr (${columns.join(", ")})
     VALUES (${columns.map((c) => `@${c}`).join(", ")})`
  ).run({ repo_id: repoId, branch, ...row });
}

async function lanes(
  branch: string,
  req: { scope?: "active" | "all"; force?: boolean; limit?: number } = {}
): Promise<LaneGraph> {
  const worktreeId = worktreeIds.get(branch);
  if (worktreeId === undefined) throw new Error(`no worktree for ${branch}`);
  const res = await bus.dispatch("graph:lanes", {
    worktreeId,
    scope: req.scope ?? "active",
    // The lane cache is module-level and outlives each test, so every call
    // that is not itself about caching recomputes.
    force: req.force ?? true,
    ...(req.limit === undefined ? {} : { limit: req.limit })
  });
  if (!res.ok) throw new Error(`graph:lanes failed: ${res.error.message}`);
  return res.value;
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-graph-"));
  repoPath = join(root, "graphRepo");
  initRepo(repoPath);
  mainTip = commit(repoPath, "init");

  // "feature": a linked worktree, so it is active outright.
  const featureWt = join(root, "graphRepo-feature");
  git(repoPath, ["worktree", "add", featureWt, "-b", "feature"]);
  commit(featureWt, "feature-work");

  // "solo": no worktree, but authored by the profile's email — also active.
  git(repoPath, ["checkout", "-b", "solo"]);
  commit(repoPath, "solo-work");
  git(repoPath, ["checkout", "main"]);

  // "shipped": unmerged in git, but its PR is merged — the active filter drops
  // it on the strength of the branch_pr row alone.
  git(repoPath, ["checkout", "-b", "shipped"]);
  commit(repoPath, "shipped-work");
  git(repoPath, ["checkout", "main"]);

  // "nopr": a worktree branch that has been checked for a PR and has none.
  const noprWt = join(root, "graphRepo-nopr");
  git(repoPath, ["worktree", "add", noprWt, "-b", "nopr"]);
  noprTip = commit(noprWt, "nopr-work");

  db = openDatabase(":memory:");
  const profile = new ProfileService(db).create({
    name: "Graph",
    email: EMAIL,
    roots: [root]
  });
  const indexer = new RepoIndexer(db, systemGit);
  const indexed = await indexer.indexRepoAt(profile.id, repoPath);
  if (!indexed.ok) throw new Error("indexRepoAt failed");
  repoId = indexed.value.id;
  for (const wt of indexed.value.worktrees) worktreeIds.set(wt.branch, wt.id);

  bus = new CommandBus();
  registerGraphHandlers(bus, db, new WorktreeStateService(db, systemGit));
});

afterEach(() => {
  // One database per describe-block file: a leftover row would be read by the
  // next test that inserts the same (repo_id, branch) instead of its own.
  db.prepare("DELETE FROM branch_pr").run();
});

describe("graph:log", () => {
  it("reports the branch root and default branch for a worktree", async () => {
    const res = await bus.dispatch("graph:log", {
      worktreeId: worktreeIds.get("feature") ?? ""
    });
    if (!res.ok) throw new Error(res.error.message);

    expect(res.value.defaultBranch).toBe("main");
    // feature branched off main's only commit, so that is the fork point.
    expect(res.value.branchRoot).toBe(mainTip);
    expect(res.value.commits[0]?.subject).toBe("feature-work");
    expect(res.value.commits.map((c) => c.hash)).toContain(mainTip);
  });

  it("honors the requested limit", async () => {
    const res = await bus.dispatch("graph:log", {
      worktreeId: worktreeIds.get("feature") ?? "",
      limit: 1
    });
    if (!res.ok) throw new Error(res.error.message);
    expect(res.value.commits).toHaveLength(1);
  });

  it("fails rather than guessing when the worktree is unknown", async () => {
    const res = await bus.dispatch("graph:log", { worktreeId: "nope" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });

  it("returns empty history for an unborn branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-empty-graph-"));
    const emptyRepo = join(root, "empty");
    initRepo(emptyRepo);

    const emptyDb = openDatabase(":memory:");
    const profile = new ProfileService(emptyDb).create({
      name: "Empty",
      email: EMAIL,
      roots: [root]
    });
    const indexer = new RepoIndexer(emptyDb, systemGit);
    const indexed = await indexer.indexRepoAt(profile.id, emptyRepo);
    if (!indexed.ok) throw new Error(indexed.error.message);
    const worktreeId = indexed.value.worktrees[0]?.id;
    if (worktreeId === undefined) throw new Error("empty worktree not indexed");
    const emptyBus = new CommandBus();
    registerGraphHandlers(
      emptyBus,
      emptyDb,
      new WorktreeStateService(emptyDb, systemGit)
    );

    const log = await emptyBus.dispatch("graph:log", { worktreeId });
    const graph = await emptyBus.dispatch("graph:lanes", {
      worktreeId,
      scope: "active",
      force: true
    });

    expect(log).toEqual(
      ok({ commits: [], branchRoot: null, defaultBranch: "main" })
    );
    expect(graph).toMatchObject({
      ok: true,
      value: {
        commits: [],
        head: "",
        defaultBranch: "main",
        defaultRef: "main",
        shownBranches: [],
        matchedBranches: 0,
        hiddenBranches: 0
      }
    });
    emptyDb.close();
  });
});

describe("graph:lanes branch info", () => {
  it("carries the whole PR summary, not just the identity columns", async () => {
    // The shipped bug: the projection stopped at is_draft, so the hover card
    // opened onto a title and nothing else — indistinguishable from a PR that
    // genuinely has no detail. Assert every detail field survives the read.
    insertPr("feature", DETAILED_PR);

    const graph = await lanes("feature");

    expect(graph.branches.feature?.pr).toEqual({
      number: 4242,
      url: DETAILED_PR.url,
      title: DETAILED_PR.title,
      state: "open",
      isDraft: false,
      forge: "github",
      host: "github.com",
      repoPath: "acme/app",
      headRefName: "feature",
      baseRefName: "main",
      additions: 128,
      deletions: 37,
      changedFiles: 9,
      commitCount: 4,
      createdAt: 1_700_000_000,
      mergedAt: 1_700_090_000
    });
  });

  it("leaves unknown detail absent rather than zero", async () => {
    // A row cached before the detail columns existed. "Not known" and "changes
    // nothing" are different claims, and the card only renders the second.
    insertPr("solo", {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "Old row",
      state: "open",
      is_draft: 0
    });

    const pr = (await lanes("feature")).branches.solo?.pr;

    expect(pr).toMatchObject({ number: 7, title: "Old row" });
    for (const key of [
      "additions",
      "deletions",
      "changedFiles",
      "commitCount",
      "createdAt",
      "mergedAt",
      "headRefName",
      "baseRefName",
      "forge",
      "host",
      "repoPath"
    ]) {
      expect(pr).not.toHaveProperty(key);
    }
  });

  it("gives a negative-cached branch no PR at all", async () => {
    // "checked, no PR" is stored as a row with a NULL number. It must not
    // reach the graph as a PR chip with number 0. Two things stop it — the
    // `number IS NOT NULL` clause and prSummaryFromRow's own guard — so this
    // pins the behavior, not either mechanism; dropping just one still passes.
    insertPr("nopr", { number: null, url: null, title: null, state: null });

    const info = (await lanes("feature")).branches.nopr;

    // The worktree adornment is still there — only the PR is absent.
    expect(info?.worktreeId).toBe(worktreeIds.get("nopr"));
    expect(info).not.toHaveProperty("pr");
  });

  it("adorns every worktree branch, drawn or not", async () => {
    const graph = await lanes("feature");
    for (const branch of ["main", "feature", "nopr"]) {
      expect(graph.branches[branch]?.worktreePath).toBeDefined();
    }
    expect(graph.branches.solo).toBeUndefined();
  });
});

describe("graph:lanes branch selection", () => {
  it("hides a branch whose PR is merged, and counts it as hidden", async () => {
    insertPr("shipped", {
      number: 11,
      url: "https://github.com/acme/app/pull/11",
      title: "Shipped",
      state: "merged",
      is_draft: 0
    });

    const graph = await lanes("feature");

    // Git still calls it unmerged; the merged PR row is what retires it.
    expect(graph.shownBranches).not.toContain("shipped");
    expect(new Set(graph.shownBranches)).toEqual(
      new Set(["feature", "solo", "nopr"])
    );
    expect(graph.matchedBranches).toBe(3);
    expect(graph.hiddenBranches).toBe(1);
    expect(graph.defaultBranch).toBe("main");
  });

  it("draws every unmerged branch in the 'all' scope", async () => {
    insertPr("shipped", {
      number: 11,
      url: "u",
      title: "Shipped",
      state: "merged",
      is_draft: 0
    });

    const graph = await lanes("feature", { scope: "all" });

    // "all" ignores both the merged-PR filter and authorship.
    expect(graph.shownBranches).toContain("shipped");
    expect(graph.hiddenBranches).toBe(0);
  });

  it("keeps the worktree's own HEAD in the graph when its branch is hidden", async () => {
    // Retiring "nopr" removes its lane, but the worktree sitting on it must
    // still get a "you are here" dot — the handler widens the log with HEAD.
    insertPr("nopr", {
      number: 12,
      url: "u",
      title: "Retired",
      state: "merged",
      is_draft: 0
    });

    const graph = await lanes("nopr");

    expect(graph.shownBranches).not.toContain("nopr");
    expect(graph.head).toBe(noprTip);
    expect(graph.commits.map((c) => c.hash)).toContain(noprTip);
    expect(graph.headOnlyCommits).toContain(noprTip);
  });

  it("fails rather than guessing when the worktree is unknown", async () => {
    const res = await bus.dispatch("graph:lanes", {
      worktreeId: "nope",
      scope: "active"
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });
});

describe("graph:lanes caching", () => {
  it("reuses the repo-level cache until forced", async () => {
    // Prime the cache with no PR rows at all.
    expect((await lanes("feature")).branches.feature?.pr).toBeUndefined();

    insertPr("feature", DETAILED_PR);

    // Within the TTL an unforced read is served from the cache, so the row
    // written a moment ago is deliberately not visible yet.
    expect(
      (await lanes("feature", { force: false })).branches.feature?.pr
    ).toBeUndefined();

    expect((await lanes("feature")).branches.feature?.pr?.number).toBe(4242);
  });

  it("caches per scope, so one scope cannot serve the other", async () => {
    insertPr("shipped", {
      number: 11,
      url: "u",
      title: "Shipped",
      state: "merged",
      is_draft: 0
    });

    await lanes("feature", { scope: "active" });
    // Unforced: if the two scopes shared a key this would return the active
    // set, which excludes "shipped".
    const all = await lanes("feature", { scope: "all", force: false });

    expect(all.shownBranches).toContain("shipped");
  });

  it("re-resolves HEAD per worktree even on a cache hit", async () => {
    // The lane set is repo-level, but the HEAD dot is not: switching the
    // selected worktree must move it without recomputing the graph.
    const feature = await lanes("feature");
    const fromCache = await lanes("main", { force: false });

    expect(fromCache.shownBranches).toEqual(feature.shownBranches);
    expect(fromCache.head).toBe(mainTip);
    expect(fromCache.head).not.toBe(feature.head);
  });
});
