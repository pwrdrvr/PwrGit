import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";

// A pin on a branch no worktree holds. Nothing here touches git: the rows the
// pin reads and writes are seeded directly, as in the profile-scope test.

let db: ReturnType<typeof openDatabase>;
let indexer: RepoIndexer;
let profileId: string;
const repoId = "repo-1";

beforeEach(() => {
  db = openDatabase(":memory:");
  indexer = new RepoIndexer(db, createSystemGit());
  profileId = new ProfileService(db).create({
    name: "ours",
    email: "ours@example.com",
    roots: []
  }).id;
  db.prepare(
    "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, 'codex', '/r/codex')"
  ).run(repoId, profileId);
  db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES ('wt-feat', ?, 'feat/x', '/r/codex-feat', 0)"
  ).run(repoId);
  // `main` is not checked out anywhere, so it is a searchable local branch.
  db.prepare(
    "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES ('lb-main', ?, 'main', 'refs/heads/main')"
  ).run(repoId);
});

const repo = () => {
  const found = indexer.getRepo(repoId);
  if (found === null) throw new Error("repo missing");
  return found;
};
const mainHit = () =>
  indexer
    .searchAll("main", { profileId, allProfiles: false })
    .find((hit) => hit.kind === "local_branch");

describe("branch pins", () => {
  it("pins a branch nothing has checked out, and lists it on the repo", () => {
    expect(repo().pinnedBranches).toBeUndefined();
    expect(mainHit()?.pinned).toBe(false);

    indexer.setBranchPinned(repoId, "main", true);

    expect(repo().pinnedBranches).toEqual(["main"]);
    expect(mainHit()?.pinned).toBe(true);
    expect(indexer.pinnedBranchNames(repoId).has("main")).toBe(true);

    indexer.setBranchPinned(repoId, "main", false);
    expect(repo().pinnedBranches).toBeUndefined();
    expect(mainHit()?.pinned).toBe(false);
  });

  it("pins the worktree holding a branch instead of listing the branch twice", () => {
    indexer.setBranchPinned(repoId, "feat/x", true);
    const wt = repo().worktrees.find((w) => w.id === "wt-feat");
    expect(wt?.pinned).toBe(true);
    expect(repo().pinnedBranches).toBeUndefined();

    indexer.setBranchPinned(repoId, "feat/x", false);
    expect(repo().worktrees.find((w) => w.id === "wt-feat")?.pinned).toBe(false);
  });

  it("keeps the pin when the branch gains a worktree", () => {
    indexer.setBranchPinned(repoId, "main", true);
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES ('wt-main', ?, 'main', '/r/codex', 1)"
    ).run(repoId);
    expect(repo().worktrees.find((w) => w.id === "wt-main")?.pinned).toBe(true);
    expect(repo().pinnedBranches).toBeUndefined();
  });

  it("lets unpinning the worktree release a pin that came from its branch", () => {
    indexer.setBranchPinned(repoId, "main", true);
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES ('wt-main', ?, 'main', '/r/codex', 1)"
    ).run(repoId);
    indexer.setWorktreePinned("wt-main", false);
    expect(repo().worktrees.find((w) => w.id === "wt-main")?.pinned).toBe(false);
    expect(indexer.pinnedBranchNames(repoId).has("main")).toBe(false);
  });

  it("carries the pin across a rename", () => {
    indexer.setBranchPinned(repoId, "main", true);
    indexer.renamePinnedBranch(repoId, "main", "trunk");
    expect(repo().pinnedBranches).toEqual(["trunk"]);
  });

  it("reads a pinned worktree as a pinned branch", () => {
    indexer.setWorktreePinned("wt-feat", true);
    expect(indexer.pinnedBranchNames(repoId)).toEqual(new Set(["feat/x"]));
  });

  it("drops the pins of a repository that is removed", () => {
    indexer.setBranchPinned(repoId, "main", true);
    db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pinned_branches").get()).toEqual({
      n: 0
    });
  });
});
