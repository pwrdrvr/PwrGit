import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { profileRepos } from "./bulk-sync-handlers";
import { HiddenRepoStore } from "./hidden-repos";
import { maintenanceRepos } from "./maintenance-handlers";
import { pruneScanInputs } from "./prune-handlers";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";

// A hide belongs to one profile. Two profiles, each with repositories of the
// same shape, is the fixture that can catch a hide leaking into the other
// profile's window (src/main/AGENTS.md, "Test it with two profiles"). No git
// runs: the search rows are written by the triggers on insert.

let db: ReturnType<typeof openDatabase>;
let indexer: RepoIndexer;
let store: HiddenRepoStore;
let mine: string;
let theirs: string;

function profile(name: string): string {
  return new ProfileService(db).create({
    name,
    email: `${name}@example.com`,
    roots: []
  }).id;
}

/** A repository with every searchable kind under it. */
function seedRepo(profileId: string, id: string, name: string): string {
  const path = `/checkouts/${id}/${name}`;
  db.prepare(
    "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
  ).run(id, profileId, name, path);
  db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, 'main', ?, 1)"
  ).run(`wt-${id}`, id, path);
  db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, 'feat/shared-work', ?, 0)"
  ).run(`wt2-${id}`, id, `${path}-feat`);
  db.prepare(
    "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES (?, ?, 'shared/local', 'refs/heads/shared/local')"
  ).run(`lb-${id}`, id);
  db.prepare(
    "INSERT INTO remote_branches (id, repo_id, remote_name, name, full_name) VALUES (?, ?, 'origin', 'shared/remote', 'refs/remotes/origin/shared/remote')"
  ).run(`rb-${id}`, id);
  db.prepare(
    `INSERT INTO repo_open_pr
       (repo_id, forge_repo, number, url, title, state, is_draft, forge, host, repo_path, head_ref, base_ref)
     VALUES (?, ?, 106, ?, 'shared pull request', 'open', 0, 'github', 'github.com', ?, 'shared/pr', 'main')`
  ).run(id, `github.com/acme/${name}`, `https://github.com/acme/${name}/pull/106`, `acme/${name}`);
  return path;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  indexer = new RepoIndexer(db, createSystemGit());
  store = new HiddenRepoStore(db, () => Date.parse("2026-10-01T12:00:00Z"), () => false);
  mine = profile("work");
  theirs = profile("home");
  seedRepo(mine, "harbor", "harbor-api");
  seedRepo(mine, "lantern", "lantern-web");
  seedRepo(theirs, "harbor2", "harbor-api");
});

const ids = (repos: { id: string }[]) => repos.map((r) => r.id).sort();

describe("HiddenRepoStore", () => {
  it("hides from one profile only", () => {
    expect(store.hide(mine, "harbor")).toMatchObject({
      profileId: mine,
      profileName: "work",
      name: "harbor-api",
      repoId: "harbor",
      worktreeCount: 2,
      missing: false,
      hiddenAt: "2026-10-01T12:00:00.000Z"
    });
    expect(ids(indexer.listRepos(mine))).toEqual(["lantern"]);
    expect(ids(indexer.listRepos(theirs))).toEqual(["harbor2"]);
    expect(store.hiddenRepoIds(mine)).toEqual(["harbor"]);
    expect(store.hiddenRepoIds(theirs)).toEqual([]);
    expect(store.isHidden("harbor")).toBe(true);
    expect(store.isHidden("harbor2")).toBe(false);
  });

  it("will not hide another profile's repository", () => {
    expect(store.hide(theirs, "harbor")).toBeNull();
    expect(ids(indexer.listRepos(mine))).toEqual(["harbor", "lantern"]);
  });

  it("still lists a hidden repository for callers asking what is on disk", () => {
    store.hide(mine, "harbor");
    expect(ids(indexer.listRepos(mine, { includeHidden: true }))).toEqual([
      "harbor",
      "lantern"
    ]);
  });

  it("survives the repository row being dropped and re-created by a scan", () => {
    store.hide(mine, "harbor");
    db.prepare("DELETE FROM repos WHERE id = 'harbor'").run();
    expect(store.list(mine)).toEqual([
      expect.objectContaining({ name: "harbor-api", repoId: null, missing: true })
    ]);
    seedRepo(mine, "harbor", "harbor-api");
    expect(ids(indexer.listRepos(mine))).toEqual(["lantern"]);
    expect(store.list(mine)[0]).toMatchObject({ repoId: "harbor", missing: false });
  });

  it("calls an unindexed entry missing only when its folder is gone", () => {
    const onDisk = new HiddenRepoStore(db, Date.now, () => true);
    onDisk.hide(mine, "harbor");
    db.prepare("DELETE FROM repos WHERE id = 'harbor'").run();
    expect(onDisk.list(mine)[0]).toMatchObject({ repoId: null, missing: false });
  });

  it("unhides by path and lists every profile when asked", () => {
    store.hide(mine, "harbor");
    store.hide(theirs, "harbor2");
    expect(store.list(null).map((h) => h.profileName)).toEqual(["home", "work"]);
    expect(store.unhide(mine, "/checkouts/harbor/harbor-api")).toBe(true);
    expect(store.unhide(mine, "/checkouts/harbor/harbor-api")).toBe(false);
    expect(ids(indexer.listRepos(mine))).toEqual(["harbor", "lantern"]);
    expect(store.list(null).map((h) => h.profileId)).toEqual([theirs]);
  });

  it("is dropped with its profile", () => {
    store.hide(theirs, "harbor2");
    db.prepare("DELETE FROM profiles WHERE id = ?").run(theirs);
    expect(store.list(null)).toEqual([]);
  });
});

describe("hidden repositories stay out of", () => {
  beforeEach(() => {
    store.hide(mine, "harbor");
  });

  it("every kind of ⌘K row, before the cap", () => {
    const hits = indexer.searchAll("shared", { profileId: mine, allProfiles: false });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.repoId === "lantern")).toBe(true);
    // The PR is matched by number, through its own capped query.
    const prs = indexer.searchAll("106", { profileId: mine, allProfiles: false });
    expect(prs.map((hit) => hit.repoId)).not.toContain("harbor");
    expect(prs.map((hit) => hit.repoId)).toContain("lantern");
  });

  it("an exact-name search, while the other profile's same-named repo still answers", () => {
    const hits = indexer.searchAll("harbor-api", { profileId: mine, allProfiles: true });
    const repos = hits.filter((hit) => hit.kind === "repo").map((hit) => hit.repoId);
    expect(repos).toEqual(["harbor2"]);
  });

  it("the palette's browse list", () => {
    const hits = indexer.searchAll("", { profileId: mine, allProfiles: false });
    expect(hits.map((hit) => hit.repoId)).toEqual(["lantern"]);
  });

  it("Fetch all, Try pull all, the pruner and maintenance", () => {
    const bulk = profileRepos(db, mine);
    expect(bulk?.map((r) => r.id)).toEqual(["lantern"]);
    expect(bulk?.flatMap((r) => r.worktrees.map((w) => w.id))).toEqual([
      "wt-lantern",
      "wt2-lantern"
    ]);
    expect(pruneScanInputs(db, mine)?.map((r) => r.id)).toEqual(["lantern"]);
    expect(maintenanceRepos(db, { profileId: mine })?.map((r) => r.id)).toEqual([
      "lantern"
    ]);
    expect(
      maintenanceRepos(db, { profileId: mine, allProfiles: true })?.map((r) => r.id)
    ).toEqual(["harbor2", "lantern"]);
  });
});

describe("RepoIndexer.deleteRepo", () => {
  it("clears branch_pr, which has no foreign key, and keeps the hide entry", () => {
    store.hide(mine, "harbor");
    db.prepare(
      "INSERT INTO branch_pr (repo_id, branch, number) VALUES ('harbor', 'main', 1)"
    ).run();
    indexer.deleteRepo("harbor");
    expect(db.prepare("SELECT COUNT(*) AS n FROM branch_pr").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM worktrees WHERE repo_id = 'harbor'").get()).toEqual({ n: 0 });
    expect(store.list(mine)).toHaveLength(1);
  });
});
