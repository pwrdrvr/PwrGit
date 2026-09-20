import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";

// ⌘K finds an open change request by number or title and answers with the
// ref that holds its head. One repository carries every case:
//
//   #106  head feat/console          — checked out in a linked worktree
//   #119  head codex/remote-only     — fetched from origin, no local branch
//   #121  a fork's fix/typo          — nothing here until fetched as pr/121
//   #130  head never/fetched         — on origin, not fetched yet
//   #1060 head gone/elsewhere        — must not answer a query for 106
//   #7    head spike/local-pr        — branch_pr only, local branch no worktree

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

let db: ReturnType<typeof openDatabase>;
let indexer: RepoIndexer;
let repoId: string;
let repoPath: string;

function openPr(
  number: number,
  title: string,
  head: string,
  extra: { headRepoPath?: string; updatedAt?: number } = {}
): void {
  db.prepare(
    `INSERT INTO repo_open_pr
       (repo_id, number, url, title, state, is_draft, forge, host, repo_path,
        head_ref, base_ref, head_repo_path, updated_at)
     VALUES (?, ?, ?, ?, 'open', 0, 'github', 'github.com', 'octo/orbit',
             ?, 'main', ?, ?)`
  ).run(
    repoId,
    number,
    `https://github.com/octo/orbit/pull/${number}`,
    title,
    head,
    extra.headRepoPath ?? null,
    extra.updatedAt ?? 1_700_000_000_000 + number
  );
}

beforeAll(async () => {
  const container = mkdtempSync(join(tmpdir(), "pwrgit-open-pr-search-"));
  repoPath = join(container, "orbit");
  initRepo(repoPath);
  const remote = join(container, "orbit.git");
  git(container, ["init", "--bare", "orbit.git"]);
  git(repoPath, ["remote", "add", "origin", remote]);
  git(repoPath, ["worktree", "add", join(container, "orbit-console"), "-b", "feat/console"]);
  git(repoPath, ["branch", "codex/remote-only"]);
  git(repoPath, ["push", "origin", "codex/remote-only"]);
  git(repoPath, ["branch", "-D", "codex/remote-only"]);
  git(repoPath, ["branch", "spike/local-pr"]);

  db = openDatabase(":memory:");
  const profile = new ProfileService(db).create({
    name: "Open PRs",
    email: "o@example.com",
    roots: []
  });
  indexer = new RepoIndexer(db, createSystemGit());
  const indexed = await indexer.indexRepoAt(profile.id, repoPath);
  if (!indexed.ok) throw new Error(indexed.error.message);
  repoId = indexed.value.id;

  openPr(106, "feat: rebuild the deploy console", "feat/console");
  openPr(119, "Bump jest from 29.7.0 to 30.1.3", "codex/remote-only");
  openPr(121, "docs: fix a typo in the quickstart", "fix/typo", {
    headRepoPath: "octo-contrib/orbit"
  });
  openPr(130, "feat: never fetched yet", "never/fetched");
  openPr(1060, "chore: an unrelated thousand-and-sixty", "gone/elsewhere");
  db.prepare(
    `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, is_draft)
     VALUES (?, 'spike/local-pr', 7, 'https://github.com/octo/orbit/pull/7',
             'spike: try the local path', 'open', 0)`
  ).run(repoId);
});

describe("searchAll with open change requests", () => {
  it("answers a PR number with the worktree that holds its head, first", () => {
    const hits = indexer.searchAll("106");
    expect(hits[0]).toMatchObject({
      kind: "worktree",
      name: "feat/console",
      pr: { number: 106, title: "feat: rebuild the deploy console" }
    });
    // Prefix matching reached #1060 in the index; the number must not.
    expect(hits.some((hit) => hit.pr?.number === 1060)).toBe(false);
    expect(hits.some((hit) => hit.kind === "change_request")).toBe(false);
  });

  it("emits a worktree matched both directly and through its PR once", () => {
    const hits = indexer.searchAll("console");
    const worktrees = hits.filter((hit) => hit.name === "feat/console");
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.pr?.number).toBe(106);
  });

  it("answers with origin's fetched branch, carrying its PR", () => {
    expect(indexer.searchAll("#119")[0]).toMatchObject({
      kind: "remote_branch",
      name: "codex/remote-only",
      remoteName: "origin",
      pr: { number: 119 }
    });
    // A remote branch matched by its own name carries its PR too.
    expect(
      indexer.searchAll("remote-only").find((hit) => hit.kind === "remote_branch")
        ?.pr?.number
    ).toBe(119);
  });

  it("puts a local branch's cached PR on its hit and in its index row", () => {
    const hit = indexer.searchAll("spike local")[0];
    expect(hit).toMatchObject({ kind: "local_branch", pr: { number: 7 } });
    // Found by title words alone, through the branch_pr trigger.
    expect(
      indexer.searchAll("try the local path").some((candidate) => candidate.name === "spike/local-pr")
    ).toBe(true);
  });

  it("returns a PR nothing here holds as a change request of its own", () => {
    expect(indexer.searchAll("typo quickstart")[0]).toMatchObject({
      kind: "change_request",
      repoId,
      name: "docs: fix a typo in the quickstart",
      pr: { number: 121, headRepoPath: "octo-contrib/orbit" }
    });
    expect(indexer.searchAll("130")[0]).toMatchObject({
      kind: "change_request",
      pr: { number: 130, headRefName: "never/fetched" }
    });
  });

  it("does not list every open PR when the query is the repository's name", () => {
    expect(
      indexer.searchAll("orbit").some((hit) => hit.kind === "change_request")
    ).toBe(false);
  });

  it("answers a fork's PR with its numbered local branch once fetched", async () => {
    git(repoPath, ["branch", "pr/121"]);
    expect((await indexer.refreshRepoRemoteBranches(repoId)).ok).toBe(true);
    expect(indexer.searchAll("121")[0]).toMatchObject({
      kind: "local_branch",
      name: "pr/121",
      pr: { number: 121 }
    });
  });

  it("drops a PR's index row when it leaves the open list", () => {
    db.prepare("DELETE FROM repo_open_pr WHERE repo_id = ? AND number = 130").run(
      repoId
    );
    expect(indexer.searchAll("never fetched")).toHaveLength(0);
  });

  // The filter that stops a repository's PRs from answering FOR the repository
  // runs on rows the index has already returned, so it cannot hand back a
  // result slot a PR spent. Every row carries the repository's name, and bm25
  // ranks partly by document length — so a short PR title outranks a worktree
  // at a deep path, and a busy repository fills the cap with rows that are
  // then all discarded. Measured on this fixture before the split query: the
  // 60 candidates were 59 change requests, and this search answered with one
  // worktree out of sixty.
  it("leaves the result cap to refs when the repository is busy", () => {
    const worktree = db.prepare(
      "INSERT INTO worktrees (id, repo_id, path, branch, is_primary) VALUES (?, ?, ?, ?, 0)"
    );
    for (let n = 0; n < 60; n++) {
      worktree.run(
        `wt-deep-${n}`,
        repoId,
        `/Users/dev/clients/acme/checkouts/platform/services/api/feature-${n}`,
        `feature-${n}`
      );
    }
    for (let n = 200; n < 400; n++) openPr(n, `Fix ${n}`, `bump/${n}`);
    const hits = indexer.searchAll("orbit");
    expect(hits.filter((hit) => hit.kind === "worktree").length).toBeGreaterThan(50);
    expect(hits.some((hit) => hit.kind === "change_request")).toBe(false);
  });

  it("follows a title change into the index", () => {
    db.prepare(
      "UPDATE repo_open_pr SET title = 'feat: renamed console work' WHERE repo_id = ? AND number = 106"
    ).run(repoId);
    expect(
      indexer.searchAll("renamed").some((hit) => hit.pr?.number === 106)
    ).toBe(true);
  });
});
