import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoIdentity } from "@pwrgit/shared";
import { createSystemGit } from "./test-support/system-git";
import {
  inspectRetrack,
  listTrackingOptions,
  retrackBranch,
  splitRemoteRefname
} from "./branch-tracking";

const systemGit = createSystemGit();
const identity: RepoIdentity = {
  host: "github", hostname: "github.com", owner: "huntharo", name: "disktree",
  nameWithOwner: "huntharo/disktree", visibility: "public", viewerCanPush: true,
  parent: { nameWithOwner: "tobi/disktree", url: "https://github.com/tobi/disktree" }
};

let root: string;
let path: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
const commit = (file: string, text: string, message: string): string => {
  writeFileSync(join(path, file), text);
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

// The disktree shape from the report: main tracks origin (the old fork),
// pwrdisk (the renamed project) is 2 ahead, upstream (the original) matches.
let base: string;
let ahead: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-branch-tracking-"));
  path = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "maintenance.auto", "false");
  base = commit("file.txt", "base\n", "base");
  commit("other.txt", "one\n", "pwrdisk one");
  ahead = commit("other.txt", "two\n", "pwrdisk two");
  git("reset", "-q", "--hard", base);
  git("remote", "add", "origin", "git@github.com:huntharo/disktree.git");
  git("remote", "add", "pwrdisk", "git@github.com:pwrdrvr/PwrDisk.git");
  git("remote", "add", "upstream", "https://github.com/tobi/disktree.git");
  git("update-ref", "refs/remotes/origin/main", base);
  git("update-ref", "refs/remotes/upstream/main", base);
  git("update-ref", "refs/remotes/pwrdisk/main", ahead);
  git("branch", "--set-upstream-to=origin/main", "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const reviewOf = async (remote = "pwrdisk") => {
  const review = await inspectRetrack(systemGit, path, { branch: "main", remote, remoteBranch: "main" }, identity);
  if (!review.ok) throw new Error(review.error.message);
  return review.value;
};
const applyFrom = (review: Awaited<ReturnType<typeof reviewOf>>, extra: { move: "none" | "forward" | "reset"; copy?: string }) =>
  retrackBranch(systemGit, path, {
    branch: review.branch,
    remote: review.target.remote,
    remoteBranch: review.target.remoteBranch,
    head: review.head,
    targetHead: review.target.head,
    upstreamRef: review.upstreamRef,
    ...extra
  });

describe("listTrackingOptions", () => {
  it("lists every remote's main against the local one, the tracked ref first", async () => {
    const choices = await listTrackingOptions(systemGit, path, "main", identity);
    expect(choices).toEqual({
      ok: true,
      value: {
        branch: "main",
        head: base,
        upstream: "origin/main",
        options: [
          { remote: "origin", remoteBranch: "main", ref: "origin/main", head: base, ahead: 0, behind: 0, tracked: true, nameWithOwner: "huntharo/disktree", canPush: true },
          { remote: "pwrdisk", remoteBranch: "main", ref: "pwrdisk/main", head: ahead, ahead: 0, behind: 2, tracked: false, nameWithOwner: "pwrdrvr/PwrDisk" },
          { remote: "upstream", remoteBranch: "main", ref: "upstream/main", head: base, ahead: 0, behind: 0, tracked: false, nameWithOwner: "tobi/disktree" }
        ]
      }
    });
  });

  it("matches a remote whose name has a slash as a whole", async () => {
    git("remote", "add", "team/fork", "git@github.com:team/fork.git");
    git("update-ref", "refs/remotes/team/fork/main", ahead);
    const choices = await listTrackingOptions(systemGit, path, "main");
    expect(choices.ok && choices.value.options.map((option) => option.ref)).toEqual([
      "origin/main", "pwrdisk/main", "team/fork/main", "upstream/main"
    ]);
    expect(splitRemoteRefname("refs/remotes/team/fork/main", ["team", "team/fork"])).toEqual({
      remote: "team/fork", remoteBranch: "main"
    });
  });
});

describe("inspectRetrack", () => {
  it("describes a fast-forward: nothing leaves, two arrive, the clean checkout here", async () => {
    const review = await reviewOf();
    expect(review).toMatchObject({
      branch: "main",
      head: base,
      upstreamRef: "refs/remotes/origin/main",
      from: { ref: "origin/main" },
      target: { ref: "pwrdisk/main", ahead: 0, behind: 2 },
      unpushed: 0,
      leavingOn: null,
      checkout: { kind: "here", dirty: 0 },
      pushOverride: null,
      copyName: "main-before-pwrdisk"
    });
    expect(review.arriving.map((commit) => commit.subject)).toEqual(["pwrdisk two", "pwrdisk one"]);
  });

  it("names where leaving commits still are, and counts the ones on no remote", async () => {
    const mine = commit("mine.txt", "mine\n", "mine");
    git("update-ref", "refs/remotes/origin/main", mine);
    expect(await reviewOf()).toMatchObject({
      target: { ahead: 1, behind: 2 }, unpushed: 0, leavingOn: "origin/main"
    });
    commit("local.txt", "local\n", "local only");
    expect(await reviewOf()).toMatchObject({ target: { ahead: 2 }, unpushed: 1, leavingOn: null });
  });

  it("reports a push override that keeps pushes going elsewhere", async () => {
    git("config", "remote.pushDefault", "origin");
    expect((await reviewOf()).pushOverride).toEqual({ key: "remote.pushDefault", remote: "origin" });
    git("config", "branch.main.pushRemote", "pwrdisk");
    expect((await reviewOf()).pushOverride).toBeNull();
  });

  it("skips a copy name that is taken", async () => {
    git("branch", "main-before-pwrdisk");
    expect((await reviewOf()).copyName).toBe("main-before-pwrdisk-2");
  });
});

describe("retrackBranch", () => {
  it("fast-forwards the checked-out branch, then tracks the new remote, keeping unrelated changes", async () => {
    writeFileSync(join(path, "file.txt"), "edited\n");
    const review = await reviewOf();
    expect(review.checkout).toEqual({ kind: "here", dirty: 1 });
    expect(await applyFrom(review, { move: "forward" })).toEqual({ ok: true, value: { moved: true, copied: null } });
    expect(git("rev-parse", "main")).toBe(ahead);
    expect(git("rev-parse", "--abbrev-ref", "main@{u}")).toBe("pwrdisk/main");
    expect(readFileSync(join(path, "file.txt"), "utf8")).toBe("edited\n");
  });

  it("changes only tracking for a same-commit remote", async () => {
    const review = await reviewOf("upstream");
    expect(await applyFrom(review, { move: "forward" })).toEqual({ ok: true, value: { moved: false, copied: null } });
    expect(git("rev-parse", "--abbrev-ref", "main@{u}")).toBe("upstream/main");
  });

  it("refuses with nothing changed when a tip moved since the review", async () => {
    const review = await reviewOf();
    git("update-ref", "refs/remotes/pwrdisk/main", base);
    const result = await applyFrom(review, { move: "forward" });
    expect(!result.ok && result.error.code).toBe("retrack_stale");
    expect(git("rev-parse", "--abbrev-ref", "main@{u}")).toBe("origin/main");
  });

  it("refuses with nothing changed when an uncommitted file would be overwritten", async () => {
    writeFileSync(join(path, "other.txt"), "dirty\n");
    const review = await reviewOf();
    const result = await applyFrom(review, { move: "forward" });
    expect(!result.ok && result.error.code).toBe("retrack_would_overwrite");
    expect(git("rev-parse", "main")).toBe(base);
    expect(git("rev-parse", "--abbrev-ref", "main@{u}")).toBe("origin/main");
    expect(readFileSync(join(path, "other.txt"), "utf8")).toBe("dirty\n");
  });

  it("will not drop a commit no remote has, unless a copy keeps it", async () => {
    const local = commit("local.txt", "local\n", "local only");
    const review = await reviewOf();
    const refused = await applyFrom(review, { move: "reset" });
    expect(!refused.ok && refused.error.code).toBe("retrack_would_drop");
    expect(git("rev-parse", "main")).toBe(local);

    const kept = await applyFrom(review, { move: "reset", copy: review.copyName });
    expect(kept).toEqual({ ok: true, value: { moved: true, copied: "main-before-pwrdisk" } });
    expect(git("rev-parse", "main")).toBe(ahead);
    expect(git("rev-parse", "main-before-pwrdisk")).toBe(local);
    expect(git("rev-parse", "--abbrev-ref", "main@{u}")).toBe("pwrdisk/main");
  });

  it("refuses a fast-forward when the branch has commits of its own", async () => {
    commit("local.txt", "local\n", "local only");
    const result = await applyFrom(await reviewOf(), { move: "forward" });
    expect(!result.ok && result.error.code).toBe("retrack_not_fast_forward");
  });

  it("moves a branch checked out nowhere with a leased ref update", async () => {
    git("switch", "-q", "-c", "work");
    const review = await reviewOf();
    expect(review.checkout).toEqual({ kind: "free" });
    expect((await applyFrom(review, { move: "forward" })).ok).toBe(true);
    expect(git("rev-parse", "main")).toBe(ahead);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("work");
  });

  it("tracks, but will not move, a branch another worktree holds", async () => {
    git("switch", "-q", "-c", "work");
    const other = join(root, "other");
    git("worktree", "add", "-q", other, "main");
    const review = await reviewOf();
    expect(review.checkout).toMatchObject({ kind: "elsewhere" });
    const moved = await applyFrom(review, { move: "forward" });
    expect(!moved.ok && moved.error.code).toBe("checked_out_elsewhere");
    expect(git("rev-parse", "main")).toBe(base);
    expect((await applyFrom(review, { move: "none" })).ok).toBe(true);
    expect(git("rev-parse", "--abbrev-ref", "main@{u}")).toBe("pwrdisk/main");
    git("worktree", "remove", "--force", other);
  });
});
