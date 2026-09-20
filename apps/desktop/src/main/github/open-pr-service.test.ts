import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenChangeRequest, PrSummary } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import type { ResolvedForge } from "../forge/providers";
import type { ForgeRepo, OpenPrList, TokenForgeProvider } from "../forge/types";
import { createSystemGit } from "../git/test-support/system-git";
import { OpenPrService } from "./open-pr-service";

const ORIGIN: ForgeRepo = { kind: "github", host: "github.com", path: "octo/orbit" };

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function openPr(
  number: number,
  head: string,
  extra: Partial<OpenChangeRequest> = {}
): OpenChangeRequest {
  return {
    number,
    url: `https://github.com/octo/orbit/pull/${number}`,
    title: `PR ${number}`,
    state: "open",
    isDraft: false,
    forge: "github",
    headRefName: head,
    baseRefName: "main",
    updatedAt: 1_700_000_000_000 + number,
    ...extra
  };
}

/**
 * A real checkout with a real origin, so fetches and ref lookups are git's own
 * answers; only the forge is faked.
 *
 *   origin has main, feat/fetched (fetched here), feat/unfetched (pushed from
 *   elsewhere, never fetched), and refs/pull/121/head (a fork's head).
 *   The checkout has a linked worktree on feat/console and a local-only
 *   branch spike/local.
 */
describe("OpenPrService", () => {
  let db: DB;
  let work: string;
  let now: number;
  let list: OpenPrList;
  let listCalls: number;
  let listFails: boolean;
  let byNumber: Map<number, PrSummary | null>;
  let numberCalls: number[][];
  let service: OpenPrService;

  const resolve = (): ResolvedForge => {
    const provider: TokenForgeProvider = {
      kind: "github",
      getToken: async () => "token",
      fetchPrsForBranches: async () => new Map(),
      fetchPrsForCommits: async () => new Map(),
      fetchPrsByNumbers: async (_token, _repo, numbers) => {
        numberCalls.push(numbers);
        return new Map(
          numbers.filter((n) => byNumber.has(n)).map((n) => [n, byNumber.get(n) ?? null])
        );
      },
      fetchOpenPrs: async () => {
        listCalls += 1;
        if (listFails) throw new Error("refused");
        return list;
      }
    };
    return { provider, repo: ORIGIN };
  };

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-open-pr-"));
    const bare = join(root, "orbit.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
    const seed = join(root, "seed");
    execFileSync("git", ["clone", bare, seed], { stdio: "ignore" });
    git(seed, ["config", "user.email", "t@t.com"]);
    git(seed, ["config", "user.name", "Tester"]);
    writeFileSync(join(seed, "README.md"), "# orbit\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "init"]);
    git(seed, ["push", "origin", "main"]);
    git(seed, ["push", "origin", "main:feat/fetched"]);
    work = join(root, "work");
    execFileSync("git", ["clone", bare, work], { stdio: "ignore" });
    // Pushed after the clone, so the checkout has never seen it.
    git(seed, ["push", "origin", "main:feat/unfetched"]);
    const tip = git(seed, ["rev-parse", "HEAD"]);
    git(bare, ["update-ref", "refs/pull/121/head", tip]);
    git(work, ["branch", "spike/local"]);
    git(work, ["worktree", "add", join(root, "work-console"), "-b", "feat/console"]);

    db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('p', 'P', 'p@example.com')"
    ).run();
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES ('repo', 'p', 'orbit', ?)"
    ).run(work);
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('wt-console', 'repo', 'feat/console', ?)"
    ).run(join(root, "work-console"));

    now = 10_000_000;
    list = { items: [], truncated: false };
    listCalls = 0;
    listFails = false;
    byNumber = new Map();
    numberCalls = [];
    service = new OpenPrService(db, createSystemGit(), {
      resolveForge: resolve,
      now: () => now
    });
  });

  afterEach(() => db.close());

  const stored = (): number[] =>
    (
      db.prepare("SELECT number FROM repo_open_pr WHERE repo_id = 'repo' ORDER BY number").all() as {
        number: number;
      }[]
    ).map((row) => row.number);

  describe("refresh", () => {
    it("stores the list, and says whether it changed", async () => {
      list = { items: [openPr(1, "a"), openPr(2, "b")], truncated: false };
      expect(await service.refresh("repo")).toBe(true);
      expect(stored()).toEqual([1, 2]);

      // Same list, past the TTL: asked again, nothing changed.
      now += 11 * 60_000;
      expect(await service.refresh("repo")).toBe(false);
      expect(listCalls).toBe(2);

      // #1 closed, #2 retitled.
      now += 11 * 60_000;
      list = { items: [openPr(2, "b", { title: "renamed" })], truncated: false };
      expect(await service.refresh("repo")).toBe(true);
      expect(stored()).toEqual([2]);
    });

    it("counts a truncation flip as a change", async () => {
      list = { items: [openPr(1, "a")], truncated: false };
      await service.refresh("repo");
      now += 11 * 60_000;
      list = { items: [openPr(1, "a")], truncated: true };
      expect(await service.refresh("repo")).toBe(true);
      expect((await service.list("repo")).truncated).toBe(true);
    });

    it("holds a fresh list for its trigger's TTL", async () => {
      await service.refresh("repo", { trigger: "user" });
      now += 30_000;
      await service.refresh("repo", { trigger: "user" });
      expect(listCalls).toBe(1);
      now += 31_000;
      await service.refresh("repo", { trigger: "user" });
      expect(listCalls).toBe(2);
      // The sweep's TTL is longer: a minute-old list is still fresh to it.
      now += 60_000;
      await service.refresh("repo", { trigger: "scheduled" });
      expect(listCalls).toBe(2);
      await service.refresh("repo", { force: true });
      expect(listCalls).toBe(3);
    });

    it("keeps the cached list through a failure, and backs off", async () => {
      list = { items: [openPr(1, "a")], truncated: false };
      await service.refresh("repo");
      now += 11 * 60_000;
      listFails = true;
      expect(await service.refresh("repo")).toBe(false);
      expect(stored()).toEqual([1]);
      // A failure writes no row, so only the mark stops the retry.
      now += 60_000;
      await service.refresh("repo");
      expect(listCalls).toBe(2);
      now += 10 * 60_000;
      await service.refresh("repo");
      expect(listCalls).toBe(3);
    });

    it("lets a waiter behind an in-flight refresh return without a second call", async () => {
      list = { items: [openPr(1, "a")], truncated: false };
      const [first, second] = await Promise.all([
        service.refresh("repo"),
        service.refresh("repo")
      ]);
      expect([first, second]).toEqual([true, false]);
      expect(listCalls).toBe(1);
    });

    it("drops a response that lands after profile deletion", async () => {
      list = { items: [openPr(1, "a")], truncated: false };
      const run = service.refresh("repo");
      service.invalidatePendingWrites();
      expect(await run).toBe(false);
      expect(stored()).toEqual([]);
    });
  });

  describe("list", () => {
    it("locates each head in the checkout", async () => {
      git(work, ["fetch", "origin"]);
      git(work, ["update-ref", "-d", "refs/remotes/origin/feat/unfetched"]);
      list = {
        items: [
          openPr(106, "feat/console"),
          openPr(7, "spike/local"),
          openPr(119, "feat/fetched"),
          openPr(130, "feat/unfetched"),
          openPr(121, "fix/typo", { headRepoPath: "octo-contrib/orbit" })
        ],
        truncated: false
      };
      await service.refresh("repo");
      const result = await service.list("repo");
      expect(result.forge).toBe("github");
      const where = Object.fromEntries(
        result.entries.map((entry) => [entry.pr.number, entry.location])
      );
      expect(where[106]).toEqual({ kind: "worktree", branch: "feat/console", worktreeId: "wt-console" });
      expect(where[7]).toEqual({ kind: "local", branch: "spike/local" });
      expect(where[119]).toEqual({
        kind: "remote",
        branch: "feat/fetched",
        fullName: "refs/remotes/origin/feat/fetched"
      });
      expect(where[130]).toEqual({ kind: "unfetched", branch: "feat/unfetched" });
      expect(where[121]).toEqual({
        kind: "fork",
        branch: "fix/typo",
        headRepoPath: "octo-contrib/orbit",
        localBranch: "pr/121",
        fetchable: true
      });
      // Newest update first, the way the forge sorts them.
      expect(result.entries.map((entry) => entry.pr.number)).toEqual([130, 121, 119, 106, 7]);
    });

    it("names no forge for an origin nobody claims", async () => {
      service = new OpenPrService(db, createSystemGit(), { resolveForge: () => null });
      expect(await service.list("repo")).toMatchObject({ forge: null, entries: [] });
    });
  });

  describe("lookup", () => {
    it("answers a listed number from the cache", async () => {
      list = { items: [openPr(106, "feat/console")], truncated: false };
      await service.refresh("repo");
      expect((await service.lookup("repo", 106))?.pr.number).toBe(106);
      expect(numberCalls).toEqual([]);
    });

    it("asks the forge once for a number the list does not hold", async () => {
      byNumber.set(98, { ...openPr(98, "gone/branch"), state: "merged" });
      const first = await service.lookup("repo", 98);
      expect(first).toMatchObject({
        pr: { number: 98, state: "merged" },
        location: { kind: "missing", branch: "gone/branch" }
      });
      await service.lookup("repo", 98);
      expect(numberCalls).toEqual([[98]]);
      // "No such number" is an answer and is remembered too.
      byNumber.set(99, null);
      expect(await service.lookup("repo", 99)).toBeNull();
      expect(await service.lookup("repo", 99)).toBeNull();
      expect(numberCalls).toEqual([[98], [99]]);
    });

    it("does not remember a number the forge never answered", async () => {
      expect(await service.lookup("repo", 404)).toBeNull();
      expect(await service.lookup("repo", 404)).toBeNull();
      expect(numberCalls).toEqual([[404], [404]]);
    });

    it("never takes a fork's head for a same-named branch of ours", async () => {
      byNumber.set(97, {
        ...openPr(97, "spike/local", { headRepoPath: "someone/orbit" }),
        state: "merged"
      });
      expect((await service.lookup("repo", 97))?.location).toMatchObject({
        kind: "fork",
        localBranch: "pr/97"
      });
    });
  });

  describe("fetchHead", () => {
    it("fetches an unfetched head into its remote-tracking ref", async () => {
      list = { items: [openPr(130, "feat/unfetched")], truncated: false };
      await service.refresh("repo");
      expect(await service.fetchHead("repo", 130)).toEqual({
        ok: true,
        value: {
          kind: "remote",
          branch: "feat/unfetched",
          fullName: "refs/remotes/origin/feat/unfetched"
        }
      });
      expect(git(work, ["rev-parse", "--verify", "refs/remotes/origin/feat/unfetched"])).toMatch(
        /^[0-9a-f]{40}$/
      );
    });

    it("checks a fork's head out as its numbered branch, pulling from the PR ref", async () => {
      list = {
        items: [openPr(121, "fix/typo", { headRepoPath: "octo-contrib/orbit" })],
        truncated: false
      };
      await service.refresh("repo");
      expect(await service.fetchHead("repo", 121)).toEqual({
        ok: true,
        value: { kind: "local", branch: "pr/121" }
      });
      expect(git(work, ["config", "branch.pr/121.merge"])).toBe("refs/pull/121/head");
      expect(git(work, ["config", "branch.pr/121.remote"])).toBe("origin");
      // Now it is here, a second fetch touches nothing.
      expect(await service.fetchHead("repo", 121)).toEqual({
        ok: true,
        value: { kind: "local", branch: "pr/121" }
      });
    });

    it("returns a head already here without fetching", async () => {
      list = { items: [openPr(106, "feat/console")], truncated: false };
      await service.refresh("repo");
      expect(await service.fetchHead("repo", 106)).toMatchObject({
        ok: true,
        value: { kind: "worktree", worktreeId: "wt-console" }
      });
    });

    it("refuses a head git would read as an option", async () => {
      list = { items: [openPr(5, "--upload-pack=touch /tmp/x")], truncated: false };
      await service.refresh("repo");
      expect(await service.fetchHead("repo", 5)).toMatchObject({
        ok: false,
        error: { code: "invalid_branch" }
      });
    });

    it("says so when the branch is gone", async () => {
      byNumber.set(98, { ...openPr(98, "gone/branch"), state: "merged" });
      expect(await service.fetchHead("repo", 98)).toMatchObject({
        ok: false,
        error: { code: "branch_gone" }
      });
    });
  });

  it("keys origin's branches and each fork's numbered branch for row decoration", async () => {
    list = {
      items: [
        openPr(119, "feat/fetched"),
        openPr(121, "main", { headRepoPath: "octo-contrib/orbit" })
      ],
      truncated: false
    };
    await service.refresh("repo");
    const prs = service.branchPrs("repo");
    expect(prs.origin.get("feat/fetched")?.number).toBe(119);
    expect(prs.local.get("pr/121")?.number).toBe(121);
    // A fork's `main` is not ours.
    expect(prs.local.has("main")).toBe(false);
    expect(prs.origin.has("main")).toBe(false);
  });
});
