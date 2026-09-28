import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import type { TokenForgeProvider } from "../forge/types";
import { PrService } from "../github/pr-service";
import { openDatabase, type DB } from "./db";

const MIGRATIONS = join(__dirname, "migrations");
const UPGRADE = "0035_pr_head_oid.sql";
/** When every pre-upgrade row was fetched: inside any refresh TTL of `SOON`. */
const FETCHED = Date.parse("2026-09-01T12:00:00.000Z");
const SOON = FETCHED + 60_000;

let container: string;
let dir: string;
let path: string;
let db: DB;

beforeEach(() => {
  container = mkdtempSync(join(tmpdir(), "pwrgit-pr-head-oid-"));
  dir = join(container, "migrations");
  mkdirSync(dir);
  for (const file of readdirSync(MIGRATIONS)) {
    if (file < UPGRADE) cpSync(join(MIGRATIONS, file), join(dir, file));
  }
  path = join(container, "app.db");
  db = openDatabase(path, dir);
  const fetchedAt = new Date(FETCHED).toISOString();
  for (const profile of ["one", "two"]) {
    db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)")
      .run(profile, profile, `${profile}@example.com`);
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
      .run(profile, profile, "project", `/${profile}`);
    const branch = db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, fetched_at)
       VALUES (?, ?, ?, 'u', 't', ?, ?)`
    );
    branch.run(profile, "shipped", 3, "merged", fetchedAt);
    branch.run(profile, "live", 4, "open", fetchedAt);
    branch.run(profile, "abandoned", 5, "closed", fetchedAt);
    // The negative cache: checked, and no PR at all.
    branch.run(profile, "local-only", null, null, fetchedAt);
  }
  db.close();
  cpSync(join(MIGRATIONS, UPGRADE), join(dir, UPGRADE));
  db = openDatabase(path, dir);
});

afterEach(() => {
  db.close();
  rmSync(container, { recursive: true, force: true });
});

it("adds head_oid to every table that shares the PR detail columns", () => {
  for (const table of ["branch_pr", "commit_pr", "repo_open_pr"]) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((column) => column.name);
    expect(columns).toContain("head_oid");
  }
});

it("expires only merged branch rows, in every profile", () => {
  const rows = db
    .prepare("SELECT repo_id, branch, fetched_at FROM branch_pr ORDER BY repo_id, branch")
    .all() as { repo_id: string; branch: string; fetched_at: string }[];
  const fetchedAt = new Date(FETCHED).toISOString();
  expect(rows).toEqual(
    ["one", "two"].flatMap((repo_id) => [
      { repo_id, branch: "abandoned", fetched_at: fetchedAt },
      { repo_id, branch: "live", fetched_at: fetchedAt },
      { repo_id, branch: "local-only", fetched_at: fetchedAt },
      { repo_id, branch: "shipped", fetched_at: "1970-01-01T00:00:00.000Z" }
    ])
  );
  // Nothing else about the cached PR moves: it keeps rendering until refetched.
  expect(
    db.prepare("SELECT number, state, head_oid FROM branch_pr WHERE branch = 'shipped'").all()
  ).toEqual([
    { number: 3, state: "merged", head_oid: null },
    { number: 3, state: "merged", head_oid: null }
  ]);
});

it("makes PrService refetch inside a TTL the old stamp would still have held", async () => {
  // The claim the SQL comment makes, checked against the reader it is about:
  // one minute after the last fetch is well inside the ten-minute sweep TTL,
  // so only the expired merged row can explain a request.
  const head = "0123456789abcdef0123456789abcdef01234567";
  const asked: string[][] = [];
  const provider: TokenForgeProvider = {
    kind: "github",
    getToken: async () => "token",
    fetchPrsForBranches: async (_token, _repo, branches) => {
      asked.push(branches);
      return new Map(branches.map((branch) => [
        branch,
        branch === "shipped"
          ? { number: 3, url: "u", title: "t", state: "merged" as const, isDraft: false, headOid: head }
          : null
      ]));
    },
    fetchPrsForCommits: async () => new Map(),
    fetchPrsByNumbers: async () => new Map(),
    fetchOpenPrs: async () => ({ items: [], truncated: false })
  };
  const git: GitExec = async (args) =>
    ok({
      stdout: args[0] === "for-each-ref"
        ? "shipped\nlive\nabandoned\nlocal-only\n"
        : "git@github.com:pwrdrvr/PwrGit.git\n",
      stderr: "",
      exitCode: 0
    });
  const service = new PrService(db, git, {
    resolveForge: () => ({
      provider,
      repo: { kind: "github", host: "github.com", path: "pwrdrvr/PwrGit" }
    }),
    now: () => SOON
  });

  await service.refreshRepo("one");

  expect(asked).toHaveLength(1);
  expect(service.cachedBranchPr("one", "shipped")).toMatchObject({ headOid: head });
});
