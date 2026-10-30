import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrSummary } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import type { ResolvedForge } from "../forge/providers";
import type { ForgeRepo, TokenForgeProvider } from "../forge/types";
import { RepoIndexer } from "../git/repo-indexer";
import { createSystemGit } from "../git/test-support/system-git";
import { timedGitSync } from "../git/test-support/git-tripwire";
import { PrService } from "./pr-service";

// Real Git against temp repositories: what `for-each-ref` reports about a
// branch's upstream and tip decides which question PrService asks, so a
// hand-written listing would only test the parser against itself.

const systemGit = createSystemGit();

const ORIGIN: ForgeRepo = { kind: "github", host: "github.com", path: "acme/widget" };

function git(cwd: string, ...args: string[]): string {
  return timedGitSync(args, cwd, () =>
    execFileSync("git", ["-C", cwd, ...args], {
      cwd: tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  );
}

/** A bare `origin` and a clone of it with one commit on `main`. */
function cloneFixture(root: string, name: string): string {
  const origin = join(root, `${name}-origin.git`);
  const local = join(root, name);
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, local);
  git(local, "config", "user.name", "Test");
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "core.autocrlf", "false");
  git(local, "config", "maintenance.auto", "false");
  writeFileSync(join(local, "README.md"), "widget\n");
  git(local, "add", ".");
  git(local, "commit", "-m", "first");
  git(local, "push", "-u", "origin", "main");
  return local;
}

function commitOn(repo: string, branch: string, file: string): string {
  git(repo, "switch", "-c", branch);
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-m", file);
  return git(repo, "rev-parse", "HEAD");
}

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 42,
    url: "https://github.com/acme/widget/pull/42",
    title: "Readiness probe",
    state: "open",
    isDraft: false,
    ...overrides
  };
}

function forge(overrides: Partial<Omit<TokenForgeProvider, "kind">>): () => ResolvedForge {
  const provider: TokenForgeProvider = {
    kind: "github",
    getToken: async () => "token",
    fetchPrsForBranches: async (_token, _repo, branches) =>
      new Map(branches.map((branch) => [branch, null])),
    fetchPrsForCommits: async (_token, _repo, hashes) =>
      new Map(hashes.map((hash) => [hash, null])),
    fetchPrsByNumbers: async () => new Map(),
    fetchOpenPrs: async () => ({ items: [], truncated: false }),
    ...overrides
  };
  return () => ({ provider, repo: ORIGIN });
}

describe("PrService asks about the name a branch was published under", () => {
  let root: string;
  let db: DB;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-pr-published-"));
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function addRepo(profile: string, repoId: string, path: string, branch: string): void {
    db.prepare(
      "INSERT OR IGNORE INTO profiles (id, name, email) VALUES (?, ?, ?)"
    ).run(profile, profile, `${profile}@example.com`);
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, 'widget', ?)"
    ).run(repoId, profile, path);
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 1)"
    ).run(`${repoId}-wt`, repoId, branch, path);
  }

  function worktreePr(profile: string, repoId: string): PrSummary | undefined {
    const repo = new RepoIndexer(db, systemGit)
      .listRepos(profile)
      .find((candidate) => candidate.id === repoId);
    return repo?.worktrees[0]?.pr;
  }

  it("queries a tracking branch by its upstream's name and files the answer under the local name", async () => {
    const local = cloneFixture(root, "widget");
    commitOn(local, "local-name", "probe.txt");
    git(local, "push", "-u", "origin", "local-name:remote-name");
    addRepo("profile", "repo", local, "local-name");

    const asked: string[][] = [];
    const service = new PrService(db, systemGit, {
      resolveForge: forge({
        fetchPrsForBranches: async (_token, _repo, branches) => {
          asked.push(branches);
          return new Map(branches.map((branch) => [
            branch,
            branch === "remote-name" ? pr({ headRefName: "remote-name" }) : null
          ]));
        }
      })
    });

    const changed = await service.refreshRepo("repo");

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("remote-name");
    expect(asked[0]).not.toContain("local-name");
    expect(changed.get("local-name")).toMatchObject({ number: 42 });
    expect(service.cachedBranchPr("repo", "local-name")).toMatchObject({
      number: 42,
      headRefName: "remote-name"
    });
    // Keyed by the local name only: nothing reads a published name back.
    expect(service.cachedBranchPr("repo", "remote-name")).toBeUndefined();
    expect(worktreePr("profile", "repo")).toMatchObject({ number: 42 });

    // Fresh under the local key, so the next sweep inside the TTL asks nothing.
    await service.refreshRepo("repo");
    expect(asked).toHaveLength(1);
  });

  it("keeps two profiles' same-named branches on their own published names", async () => {
    const mine = cloneFixture(root, "mine");
    commitOn(mine, "local-name", "mine.txt");
    git(mine, "push", "-u", "origin", "local-name:remote-name");
    const theirs = cloneFixture(root, "theirs");
    commitOn(theirs, "local-name", "theirs.txt");
    git(theirs, "push", "-u", "origin", "local-name:other-name");
    addRepo("me", "mine", mine, "local-name");
    addRepo("them", "theirs", theirs, "local-name");

    const service = new PrService(db, systemGit, {
      resolveForge: forge({
        fetchPrsForBranches: async (_token, _repo, branches) =>
          new Map(branches.map((branch) => [
            branch,
            branch === "remote-name"
              ? pr({ number: 7, headRefName: branch })
              : branch === "other-name"
                ? pr({ number: 8, headRefName: branch })
                : null
          ]))
      })
    });
    await service.refreshRepo("mine");
    await service.refreshRepo("theirs");

    expect(worktreePr("me", "mine")).toMatchObject({ number: 7 });
    expect(worktreePr("them", "theirs")).toMatchObject({ number: 8 });
    expect(worktreePr("me", "theirs")).toBeUndefined();
  });

  it("finds a no-upstream branch's merged change request by its tip, and only its tip", async () => {
    const local = cloneFixture(root, "widget");
    commitOn(local, "deploy/pinned", "one.txt");
    writeFileSync(join(local, "two.txt"), "two\n");
    git(local, "add", ".");
    git(local, "commit", "-m", "two");
    const tip = git(local, "rev-parse", "HEAD");
    // Published under another name, squash-merged, its branch deleted: no
    // upstream, and no remote ref holds the commits.
    git(local, "push", "origin", "HEAD:feat/pinned-readiness");
    git(local, "push", "origin", "--delete", "feat/pinned-readiness");
    addRepo("profile", "repo", local, "deploy/pinned");

    const commitAsks: string[][] = [];
    const announced: Array<Map<string, PrSummary | null>> = [];
    const merged = pr({
      number: 116,
      state: "merged",
      headRefName: "feat/pinned-readiness",
      headOid: tip
    });
    const service = new PrService(db, systemGit, {
      resolveForge: forge({
        fetchPrsForCommits: async (_token, _repo, hashes) => {
          commitAsks.push(hashes);
          return new Map(hashes.map((hash) => [hash, hash === tip ? merged : null]));
        }
      })
    });
    service.onCommitsChanged((_repoId, changed) => announced.push(changed));

    const changed = await service.refreshRepo("repo");

    // One exact SHA for the one no-upstream branch; `main` tracks origin.
    expect(commitAsks).toEqual([[tip]]);
    expect(changed.get("deploy/pinned")).toMatchObject({ number: 116, state: "merged" });
    expect(worktreePr("profile", "repo")).toMatchObject({ number: 116, headOid: tip });
    // The association went through commit_pr, and the commit list hears of it.
    expect(service.cachedCommitPrs("repo", [tip]).get(tip)).toMatchObject({ number: 116 });
    expect(announced.map((delta) => [...delta.keys()])).toEqual([[tip]]);
  });

  it("does not attach a change request whose head is not the tip", async () => {
    const local = cloneFixture(root, "widget");
    commitOn(local, "deploy/pinned", "one.txt");
    const tip = git(local, "rev-parse", "HEAD");
    addRepo("profile", "repo", local, "deploy/pinned");

    const service = new PrService(db, systemGit, {
      resolveForge: forge({
        // The forge associates the commit with a change request that went on
        // past it: its head is a later commit, so this tip is not it.
        fetchPrsForCommits: async (_token, _repo, hashes) =>
          new Map(hashes.map((hash) => [
            hash,
            hash === tip
              ? pr({ number: 9, state: "merged", headOid: "f".repeat(40) })
              : null
          ]))
      })
    });

    const changed = await service.refreshRepo("repo");

    expect(changed.get("deploy/pinned")).toBeNull();
    expect(service.cachedBranchPr("repo", "deploy/pinned")).toBeNull();
    expect(worktreePr("profile", "repo")).toBeUndefined();
  });

  it("never asks about the tip of a branch that has an upstream", async () => {
    const local = cloneFixture(root, "widget");
    commitOn(local, "feature", "feature.txt");
    git(local, "push", "-u", "origin", "feature");
    addRepo("profile", "repo", local, "feature");

    const commitAsks: string[][] = [];
    const service = new PrService(db, systemGit, {
      resolveForge: forge({
        fetchPrsForCommits: async (_token, _repo, hashes) => {
          commitAsks.push(hashes);
          return new Map(hashes.map((hash) => [hash, null]));
        }
      })
    });

    await service.refreshRepo("repo");

    expect(commitAsks).toEqual([]);
    expect(service.cachedBranchPr("repo", "feature")).toBeNull();
  });
});
