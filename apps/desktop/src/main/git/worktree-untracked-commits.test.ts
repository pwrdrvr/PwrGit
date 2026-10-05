import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { checkRemoteTips } from "./auto-remote-check";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";
import { WorktreeStateService } from "./worktree-state";

const systemGit = createSystemGit();
const unlocked = <T>(run: () => Promise<T>): Promise<T> => run();
function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    cwd: tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

describe("worktree commits without upstream tracking (real bare remote)", () => {
  let root: string;
  let repo: string;
  let linked: string;
  let db: DB;
  let service: WorktreeStateService;
  let indexer: RepoIndexer;
  let repoId: string;
  let worktreeId: string;
  let otherId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-untracked-commits-"));
    const remote = join(root, "remote.git");
    repo = join(root, "repo");
    linked = join(root, "linked");
    git(root, "init", "--bare", "-b", "main", remote);
    git(root, "clone", remote, repo);
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "fixture@example.com");
    git(repo, "config", "push.autoSetupRemote", "false");
    git(repo, "commit", "--allow-empty", "-m", "base");
    git(repo, "push", "-u", "origin", "main");
    git(repo, "worktree", "add", "--no-track", "-b", "topic", linked, "main");
    git(linked, "commit", "--allow-empty", "-m", "published topic");
    // Deliberately omit -u: publication does not imply tracking configuration.
    git(linked, "push", "origin", "topic");
    expect(git(linked, "status", "--porcelain=v2", "--branch"))
      .not.toMatch(/branch\.(upstream|ab)/);

    db = openDatabase(":memory:");
    const profiles = new ProfileService(db);
    indexer = new RepoIndexer(db, systemGit);
    const first = profiles.create({ name: "Local work", email: "first@example.com" });
    const added = await indexer.indexRepoAt(first.id, repo);
    if (!added.ok) throw new Error(added.error.message);
    repoId = added.value.id;
    const row = added.value.worktrees.find((w) => w.branch === "topic");
    if (row === undefined) throw new Error("linked worktree not indexed");
    worktreeId = row.id;

    // Same branch name in another profile must not share this worktree's count.
    const otherRepo = join(root, "other");
    git(root, "clone", "-b", "topic", remote, otherRepo);
    const second = profiles.create({ name: "Published work", email: "second@example.com" });
    const other = await indexer.indexRepoAt(second.id, otherRepo);
    if (!other.ok) throw new Error(other.error.message);
    otherId = other.value.worktrees[0]!.id;
    service = new WorktreeStateService(db, systemGit);
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("counts a genuinely local commit after publishing without -u, then clears it after push", async () => {
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 0 });
    git(linked, "commit", "--allow-empty", "-m", "genuinely local");
    expect(git(linked, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("1");
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 1, behind: 0 });
    expect(service.getCached(worktreeId)?.ahead).toBe(1);
    expect(indexer.getRepo(repoId)?.worktrees.find((w) => w.id === worktreeId)?.ahead).toBe(1);
    expect(await service.compute(otherId)).toMatchObject({ hasUpstream: true, ahead: 0 });

    git(linked, "push", "origin", "topic");
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 0 });
  });

  it("refreshes a stale same-name remote ref without configuring an upstream", async () => {
    const old = git(linked, "rev-parse", "origin/topic");
    git(linked, "commit", "--allow-empty", "-m", "published elsewhere");
    git(linked, "push", "origin", "topic");
    // Model a push from another client that did not update this tracking ref.
    git(linked, "update-ref", "refs/remotes/origin/topic", old);
    expect(git(linked, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("1");
    expect(git(linked, "ls-remote", "origin", "refs/heads/topic"))
      .toBe(`${git(linked, "rev-parse", "HEAD")}\trefs/heads/topic`);
    let refreshed = false;
    expect((await checkRemoteTips(systemGit, [{ id: worktreeId, path: linked, branch: "topic" }], null, unlocked,
      () => { refreshed = true; })).get(worktreeId)).toEqual(ok("checked"));
    expect(refreshed).toBe(true);
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 0 });
  });

  it("does not treat a detached checkout or unborn branch as unpublished commits", async () => {
    git(linked, "commit", "--allow-empty", "-m", "detached local");
    git(linked, "checkout", "--detach");
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 0 });
    git(linked, "switch", "--orphan", "unborn");
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 0 });
  });

  it("excludes commits published to another remote under a different branch name", async () => {
    git(linked, "commit", "--allow-empty", "-m", "published under another name");
    const otherRemote = join(root, "other-remote.git");
    git(root, "init", "--bare", otherRemote);
    git(repo, "remote", "add", "backup", otherRemote);
    git(linked, "push", "backup", "topic:review/topic");
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 0 });
  });

  it("counts a never-published branch but retains upstream-relative counts once tracking is configured", async () => {
    git(linked, "switch", "--no-track", "-c", "never-published");
    git(linked, "commit", "--allow-empty", "-m", "local only");
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: false, ahead: 1 });
    git(linked, "branch", "--set-upstream-to=origin/topic");
    // Publishing the commit elsewhere must not suppress the configured
    // upstream's ahead count: that branch still needs this commit.
    git(linked, "push", "origin", "HEAD:elsewhere");
    expect(await service.compute(worktreeId)).toMatchObject({ hasUpstream: true, ahead: 1 });
  });

  it("preserves the snapshot if Git cannot count the local commits", async () => {
    let failCount = false;
    const flaky = new WorktreeStateService(db, (args, cwd, options) =>
      failCount && args[0] === "rev-list" && args.includes("--not")
        ? Promise.resolve(ok({ exitCode: 128, stdout: "", stderr: "transient read failure" }))
        : systemGit(args, cwd, options)
    );
    git(linked, "commit", "--allow-empty", "-m", "local");
    expect(await flaky.compute(worktreeId)).toMatchObject({ ahead: 1 });
    failCount = true;
    expect(await flaky.compute(worktreeId)).toEqual(flaky.getCached(worktreeId));
    expect(flaky.getCached(worktreeId)?.ahead).toBe(1);
  });
});
