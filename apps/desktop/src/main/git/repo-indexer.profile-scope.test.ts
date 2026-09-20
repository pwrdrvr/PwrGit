import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";

// ⌘K answered a query in one profile's window with another profile's branch.
// Two profiles, each holding a repository with the same shape, is the only
// fixture that can fail that way — see "Test it with two profiles" in
// ../AGENTS.md. Nothing here touches git: the FTS rows are written by the
// triggers on insert, which is what the scope filter reads.

let db: ReturnType<typeof openDatabase>;
let indexer: RepoIndexer;
let mine: string;
let theirs: string;

/** A profile holding one repository, with every searchable kind under it. */
function seed(name: string, repo: string, branch: string): string {
  const profile = new ProfileService(db).create({
    name,
    email: `${name}@example.com`,
    roots: []
  });
  const repoId = `repo-${name}`;
  db.prepare(
    "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
  ).run(repoId, profile.id, repo, `/checkouts/${name}/${repo}`);
  db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 1)"
  ).run(`wt-${name}`, repoId, branch, `/checkouts/${name}/${repo}/main`);
  db.prepare(
    "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES (?, ?, ?, ?)"
  ).run(`lb-${name}`, repoId, branch, `refs/heads/${branch}`);
  db.prepare(
    "INSERT INTO remote_branches (id, repo_id, remote_name, name, full_name) VALUES (?, ?, 'origin', ?, ?)"
  ).run(
    `rb-${name}`,
    repoId,
    `${branch}-remote`,
    `refs/remotes/origin/${branch}-remote`
  );
  db.prepare(
    `INSERT INTO repo_open_pr
       (repo_id, number, url, title, state, is_draft, forge, host, repo_path, head_ref, base_ref)
     VALUES (?, 106, ?, ?, 'open', 0, 'github', 'github.com', ?, ?, 'main')`
  ).run(
    repoId,
    `https://github.com/${name}/${repo}/pull/106`,
    `feat: ${name} pull request`,
    `${name}/${repo}`,
    `${branch}-pr`
  );
  return profile.id;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  indexer = new RepoIndexer(db, createSystemGit());
  mine = seed("ours", "deploy-tools", "shared/branch-name");
  theirs = seed("theirs", "deploy-tools-too", "shared/branch-name");
});

const scoped = (query: string) =>
  indexer.searchAll(query, { profileId: mine, allProfiles: false });

describe("searchAll profile scope", () => {
  it("answers only from the asking profile", () => {
    const hits = scoped("shared");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.profileId === mine)).toBe(true);
    expect(hits.some((hit) => hit.profileId === theirs)).toBe(false);
  });

  it("keeps a change request from another profile out of a number query", () => {
    // Both profiles have a #106. Only this profile's may answer.
    const hits = scoped("106");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.profileId === mine)).toBe(true);
  });

  it("scopes the empty-query browse list too", () => {
    const hits = indexer.searchAll("", { profileId: mine, allProfiles: false });
    expect(hits.map((hit) => hit.name)).toEqual(["deploy-tools"]);
  });

  it("includes both profiles when the reader asked for all of them", () => {
    const hits = indexer.searchAll("shared", {
      profileId: mine,
      allProfiles: true
    });
    expect(hits.some((hit) => hit.profileId === theirs)).toBe(true);
    // Still the reader's own profile first — the other one is reachable, not
    // in the way.
    expect(hits[0]?.profileId).toBe(mine);
  });

  it("browses every profile when asked, this profile's repos first", () => {
    const hits = indexer.searchAll("", { profileId: mine, allProfiles: true });
    expect(hits.map((hit) => hit.name)).toEqual([
      "deploy-tools",
      "deploy-tools-too"
    ]);
  });

  it("searches every profile when no profile asked", () => {
    const hits = indexer.searchAll("shared");
    expect(hits.some((hit) => hit.profileId === theirs)).toBe(true);
  });

  // The filter has to run in SQL: both queries are capped, so rows excluded
  // afterwards would already have spent slots this profile needed.
  it("never spends the result cap on another profile's rows", () => {
    const branch = db.prepare(
      "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES (?, ?, ?, ?)"
    );
    const pr = db.prepare(
      `INSERT INTO repo_open_pr
         (repo_id, number, url, title, state, is_draft, forge, host, repo_path, head_ref, base_ref)
       VALUES (?, ?, ?, ?, 'open', 0, 'github', 'github.com', 'x/y', ?, 'main')`
    );
    for (let n = 0; n < 200; n++) {
      branch.run(
        `noise-${n}`,
        "repo-theirs",
        `shared/theirs-${n}`,
        `refs/heads/shared/theirs-${n}`
      );
      pr.run("repo-theirs", 500 + n, `u${n}`, `shared work ${n}`, `s/${n}`);
    }
    for (let n = 0; n < 40; n++) {
      branch.run(
        `ours-${n}`,
        "repo-ours",
        `shared/ours-${n}`,
        `refs/heads/shared/ours-${n}`
      );
    }
    const hits = scoped("shared");
    expect(hits.every((hit) => hit.profileId === mine)).toBe(true);
    // All 40, plus this profile's own worktree, branch and remote branch.
    expect(hits.filter((hit) => hit.kind === "local_branch").length).toBe(41);
  });
});
