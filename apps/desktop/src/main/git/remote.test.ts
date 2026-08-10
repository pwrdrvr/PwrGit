import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type RemoteDivergence, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  addRemote,
  fetchRemote,
  inspectRemoteDivergence,
  listRepoRefs,
  planPushRefs,
  pullFastForward,
  pushPlannedRefs,
  pushRemote,
  rebaseOntoUpstream,
  removeRemote,
  resetToUpstream,
  updateRemote
} from "./git-service";

const systemGit: GitExec = (args, cwd) =>
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
  });

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}
function gitOut(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
function configure(dir: string, name: string): void {
  git(dir, ["config", "user.email", `${name}@t.com`]);
  git(dir, ["config", "user.name", name]);
}
function commit(dir: string, file: string, msg: string): void {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", msg]);
}

function recoverySnapshot(
  divergence: RemoteDivergence
): Pick<RemoteDivergence, "branch" | "head" | "upstreamHead"> {
  return {
    branch: divergence.branch,
    head: divergence.head,
    upstreamHead: divergence.upstreamHead
  };
}

function makeDivergedFixture(): { local: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-diverged-"));
  git(root, ["init", "--bare", "-b", "main", "origin.git"]);

  const local = join(root, "local");
  git(root, ["clone", "origin.git", "local"]);
  configure(local, "local");
  commit(local, "base.txt", "base");
  git(local, ["push", "-u", "origin", "main"]);

  const remote = join(root, "remote");
  git(root, ["clone", "origin.git", "remote"]);
  configure(remote, "remote");
  return { local, remote };
}

let cloneA: string;
let cloneB: string;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-remote-"));
  git(root, ["init", "--bare", "-b", "main", "origin.git"]);

  cloneA = join(root, "A");
  git(root, ["clone", "origin.git", "A"]);
  configure(cloneA, "A");
  commit(cloneA, "f.txt", "c1");
  git(cloneA, ["push", "-u", "origin", "main"]);

  cloneB = join(root, "B");
  git(root, ["clone", "origin.git", "B"]);
  configure(cloneB, "B");
});

describe("remote ops (bare-remote fixture)", () => {
  it("adds, edits, renames, and removes arbitrary remotes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-remote-config-"));
    git(root, ["init", "--bare", "-b", "main", "fetch.git"]);
    git(root, ["init", "--bare", "-b", "main", "push.git"]);
    const local = join(root, "local");
    git(root, ["init", "-b", "main", "local"]);

    const added = await addRemote(systemGit, local, {
      name: "mac-tests",
      fetchUrl: join(root, "fetch.git"),
      pushUrl: join(root, "push.git")
    });
    expect(added.ok).toBe(true);
    expect(gitOut(local, ["remote", "get-url", "mac-tests"])).toBe(
      join(root, "fetch.git")
    );
    expect(gitOut(local, ["remote", "get-url", "--push", "mac-tests"])).toBe(
      join(root, "push.git")
    );

    const updated = await updateRemote(systemGit, local, {
      originalName: "mac-tests",
      name: "mac-arm-tests",
      fetchUrl: join(root, "push.git")
    });
    expect(updated.ok).toBe(true);
    expect(gitOut(local, ["remote"])).toBe("mac-arm-tests");
    expect(gitOut(local, ["remote", "get-url", "mac-arm-tests"])).toBe(
      join(root, "push.git")
    );

    const removed = await removeRemote(systemGit, local, "mac-arm-tests");
    expect(removed.ok).toBe(true);
    expect(gitOut(local, ["remote"])).toBe("");
  });

  it("lists multiple remotes and safely pushes one source to multiple targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-multi-remote-"));
    for (const remote of ["origin", "upstream", "mac-tests"]) {
      git(root, ["init", "--bare", "-b", "main", `${remote}.git`]);
    }
    const local = join(root, "local");
    git(root, ["init", "-b", "main", "local"]);
    configure(local, "local");
    commit(local, "base.txt", "base");
    for (const remote of ["origin", "upstream", "mac-tests"]) {
      git(local, ["remote", "add", remote, join(root, `${remote}.git`)]);
    }
    git(local, ["push", "-u", "origin", "main"]);
    git(local, ["push", "upstream", "main"]);
    commit(local, "upstream.txt", "advance upstream");
    git(local, ["push", "upstream", "main"]);
    git(local, ["fetch", "--all"]);

    const refs = await listRepoRefs(
      systemGit,
      local,
      new Map([["main", ["primary"]]])
    );
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    expect(refs.value.remotes.map((remote) => remote.name)).toEqual([
      "mac-tests",
      "origin",
      "upstream"
    ]);
    expect(refs.value.branches[0]).toMatchObject({
      name: "main",
      checkedOutWorktreeIds: ["primary"]
    });

    const planned = await planPushRefs(
      systemGit,
      local,
      "refs/remotes/upstream/main",
      [
        { remote: "origin", branch: "main" },
        { remote: "mac-tests", branch: "playwright/main" }
      ]
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.map((plan) => plan.relation)).toEqual([
      "fast_forward",
      "create"
    ]);

    const pushed = await pushPlannedRefs(systemGit, local, planned.value);
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.map((result) => result.outcome)).toEqual([
      "pushed",
      "pushed"
    ]);
    const upstreamHead = gitOut(local, ["rev-parse", "upstream/main"]);
    expect(
      gitOut(root, ["--git-dir", "origin.git", "rev-parse", "refs/heads/main"])
    ).toBe(upstreamHead);
    expect(
      gitOut(root, [
        "--git-dir",
        "mac-tests.git",
        "rev-parse",
        "refs/heads/playwright/main"
      ])
    ).toBe(upstreamHead);
  }, 20_000);

  it("plans and pushes against a remote's configured push URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-push-url-"));
    git(root, ["init", "--bare", "-b", "main", "fetch.git"]);
    git(root, ["init", "--bare", "-b", "main", "push.git"]);
    const local = join(root, "local");
    git(root, ["init", "-b", "main", "local"]);
    configure(local, "local");
    commit(local, "base.txt", "base");
    git(local, ["remote", "add", "target", join(root, "fetch.git")]);
    git(local, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "target",
      join(root, "push.git")
    ]);
    git(local, ["push", join(root, "fetch.git"), "main"]);

    const planned = await planPushRefs(systemGit, local, "refs/heads/main", [
      { remote: "target", branch: "main" }
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value[0]?.relation).toBe("create");

    const pushed = await pushPlannedRefs(systemGit, local, planned.value);
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value[0]?.outcome).toBe("pushed");
    expect(
      gitOut(root, ["--git-dir", "push.git", "rev-parse", "refs/heads/main"])
    ).toBe(planned.value[0]?.sourceHead);
  });

  it(
    "pushes the reviewed object if the source ref changes during execution",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pwrgit-reviewed-source-"));
      git(root, ["init", "--bare", "-b", "main", "target.git"]);
      const local = join(root, "local");
      git(root, ["init", "-b", "main", "local"]);
      configure(local, "local");
      commit(local, "base.txt", "reviewed");
      git(local, ["remote", "add", "target", join(root, "target.git")]);

      const planned = await planPushRefs(systemGit, local, "refs/heads/main", [
        { remote: "target", branch: "main" }
      ]);
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      const reviewedHead = planned.value[0]?.sourceHead;
      expect(reviewedHead).toBeDefined();
      if (reviewedHead === undefined) return;
      const tree = gitOut(local, ["rev-parse", `${reviewedHead}^{tree}`]);
      const unreviewedHead = gitOut(local, [
        "commit-tree",
        tree,
        "-p",
        reviewedHead,
        "-m",
        "unreviewed"
      ]);
      let sourceMoved = false;
      const moveSourceDuringInspection: GitExec = async (args, cwd) => {
        if (!sourceMoved && args[0] === "ls-remote") {
          sourceMoved = true;
          git(local, ["update-ref", "refs/heads/main", unreviewedHead]);
        }
        return systemGit(args, cwd);
      };

      const pushed = await pushPlannedRefs(
        moveSourceDuringInspection,
        local,
        planned.value
      );
      expect(sourceMoved).toBe(true);
      expect(pushed.ok).toBe(true);
      if (!pushed.ok) return;
      expect(pushed.value[0]?.outcome).toBe("pushed");
      expect(gitOut(local, ["rev-parse", "refs/heads/main"])).toBe(
        unreviewedHead
      );
      expect(
        gitOut(root, [
          "--git-dir",
          "target.git",
          "rev-parse",
          "refs/heads/main"
        ])
      ).toBe(reviewedHead);
    }
  );

  it("push sends a new commit to the remote", async () => {
    commit(cloneB, "g.txt", "c2 from B");
    const result = await pushRemote(systemGit, cloneB);
    expect(result.ok).toBe(true);
  });

  it("pull fast-forwards a behind branch and advances the tree", async () => {
    const result = await pullFastForward(systemGit, cloneA);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fastForwarded).toBe(true);
    expect(existsSync(join(cloneA, "g.txt"))).toBe(true);
  });

  it("restores the original checkout before reapplying work after a partial merge failure", async () => {
    const { local, remote } = makeDivergedFixture();
    writeFileSync(join(remote, "base.txt"), "upstream version\n");
    writeFileSync(join(remote, "upstream.txt"), "added upstream\n");
    git(remote, ["add", "."]);
    git(remote, ["commit", "-m", "advance upstream"]);
    git(remote, ["push"]);

    const originalHead = gitOut(local, ["rev-parse", "HEAD"]);
    writeFileSync(join(local, "base.txt"), "staged work\n");
    git(local, ["add", "base.txt"]);
    writeFileSync(join(local, "base.txt"), "staged work\nunstaged work\n");
    writeFileSync(join(local, "untracked.txt"), "keep me\n");
    const originalStatus = gitOut(local, ["status", "--porcelain"]);
    const originalStagedDiff = gitOut(local, ["diff", "--cached"]);
    const originalUnstagedDiff = gitOut(local, ["diff"]);
    let sawPartialMutation = false;
    let restoredBeforePop = false;
    let reappliedWithIndex = false;

    const failAfterPartialCheckout: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        git(cwd, ["checkout", "origin/main", "--", "base.txt", "upstream.txt"]);
        sawPartialMutation =
          readFileSync(join(cwd, "base.txt"), "utf8") === "upstream version\n" &&
          existsSync(join(cwd, "upstream.txt")) &&
          gitOut(cwd, ["diff", "--cached", "--name-only"]) !== "";
        return ok({
          stdout: "",
          stderr: "simulated merge checkout failure",
          exitCode: 128
        });
      }
      if (args[0] === "stash" && args[1] === "pop") {
        reappliedWithIndex = args.includes("--index");
        restoredBeforePop =
          gitOut(cwd, ["rev-parse", "HEAD"]) === originalHead &&
          gitOut(cwd, ["status", "--porcelain"]) === "" &&
          readFileSync(join(cwd, "base.txt"), "utf8") === "base.txt\n" &&
          !existsSync(join(cwd, "upstream.txt"));
      }
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failAfterPartialCheckout, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("merge_failed");
    expect(sawPartialMutation).toBe(true);
    expect(restoredBeforePop).toBe(true);
    expect(reappliedWithIndex).toBe(true);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(readFileSync(join(local, "base.txt"), "utf8")).toBe(
      "staged work\nunstaged work\n"
    );
    expect(readFileSync(join(local, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(local, "upstream.txt"))).toBe(false);
    expect(gitOut(local, ["status", "--porcelain"])).toBe(originalStatus);
    expect(gitOut(local, ["diff", "--cached"])).toBe(originalStagedDiff);
    expect(gitOut(local, ["diff"])).toBe(originalUnstagedDiff);
    expect(gitOut(local, ["stash", "list"])).toBe("");
  }, 15_000);

  it("preserves staged and unstaged state when reapplying work after a successful pull", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(remote, "upstream.txt", "advance upstream");
    git(remote, ["push"]);

    writeFileSync(join(local, "base.txt"), "staged work\n");
    git(local, ["add", "base.txt"]);
    writeFileSync(join(local, "base.txt"), "staged work\nunstaged work\n");
    writeFileSync(join(local, "untracked.txt"), "keep me\n");
    const originalStatus = gitOut(local, ["status", "--porcelain"]);
    const originalStagedDiff = gitOut(local, ["diff", "--cached"]);
    const originalUnstagedDiff = gitOut(local, ["diff"]);

    const result = await pullFastForward(systemGit, local);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        fastForwarded: true,
        stashed: true,
        reappliedWithConflicts: false
      });
    }
    expect(existsSync(join(local, "upstream.txt"))).toBe(true);
    expect(gitOut(local, ["status", "--porcelain"])).toBe(originalStatus);
    expect(gitOut(local, ["diff", "--cached"])).toBe(originalStagedDiff);
    expect(gitOut(local, ["diff"])).toBe(originalUnstagedDiff);
    expect(readFileSync(join(local, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect(gitOut(local, ["stash", "list"])).toBe("");
  }, 15_000);

  it("keeps a conflicting indexed stash recoverable after a successful pull", async () => {
    const { local, remote } = makeDivergedFixture();
    writeFileSync(join(remote, "base.txt"), "upstream work\n");
    git(remote, ["add", "base.txt"]);
    git(remote, ["commit", "-m", "change base upstream"]);
    git(remote, ["push"]);

    writeFileSync(join(local, "base.txt"), "local staged work\n");
    git(local, ["add", "base.txt"]);

    const result = await pullFastForward(systemGit, local);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        fastForwarded: true,
        stashed: true,
        reappliedWithConflicts: true
      });
    }
    expect(gitOut(local, ["status", "--porcelain"])).toContain("UU base.txt");
    expect(readFileSync(join(local, "base.txt"), "utf8")).toContain("<<<<<<<");
    expect(gitOut(local, ["stash", "list"])).toContain(
      "pwrgit: auto-stash before pull"
    );
  }, 15_000);

  it("stops without merging or losing work when auto-stash exits nonzero", async () => {
    const { local } = makeDivergedFixture();
    const originalHead = gitOut(local, ["rev-parse", "HEAD"]);
    writeFileSync(join(local, "base.txt"), "local work\n");
    let mergeCalled = false;

    const failingStashGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "stash" && args[1] === "push") {
        return ok({ stdout: "", stderr: "simulated stash failure", exitCode: 1 });
      }
      if (args[0] === "merge") mergeCalled = true;
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failingStashGit, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("exit_1");
    expect(mergeCalled).toBe(false);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(readFileSync(join(local, "base.txt"), "utf8")).toBe("local work\n");
    expect(gitOut(local, ["stash", "list"])).toBe("");
  }, 15_000);

  it("stops before stashing or merging when status exits nonzero", async () => {
    const { local } = makeDivergedFixture();
    let stashOrMergeCalled = false;
    const failingStatusGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "status") {
        return ok({ stdout: "", stderr: "simulated status failure", exitCode: 128 });
      }
      if (args[0] === "stash" || args[0] === "merge") stashOrMergeCalled = true;
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failingStatusGit, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("exit_128");
    expect(stashOrMergeCalled).toBe(false);
  }, 15_000);

  it("keeps the stash and reports when failed-pull rollback cannot complete", async () => {
    const { local } = makeDivergedFixture();
    writeFileSync(join(local, "base.txt"), "local work\n");
    let popCalled = false;
    const failingRollbackGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        return ok({ stdout: "", stderr: "merge failed", exitCode: 128 });
      }
      if (args[0] === "reset") {
        return ok({ stdout: "", stderr: "reset failed", exitCode: 128 });
      }
      if (args[0] === "stash" && args[1] === "pop") popCalled = true;
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failingRollbackGit, local);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("pull_rollback_failed");
      expect(result.error.message).toContain("local changes remain in the stash");
    }
    expect(popCalled).toBe(false);
    expect(gitOut(local, ["stash", "list"])).toContain(
      "pwrgit: auto-stash before pull"
    );
  }, 15_000);

  it("reports a failed stash reapply instead of hiding the cleanup failure", async () => {
    const { local } = makeDivergedFixture();
    const originalHead = gitOut(local, ["rev-parse", "HEAD"]);
    writeFileSync(join(local, "base.txt"), "local work\n");
    const failingPopGit: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        return ok({ stdout: "", stderr: "merge failed", exitCode: 128 });
      }
      if (args[0] === "stash" && args[1] === "pop") {
        return ok({ stdout: "", stderr: "stash pop failed", exitCode: 1 });
      }
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failingPopGit, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stash_reapply_failed");
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(gitOut(local, ["status", "--porcelain"])).toBe("");
    expect(gitOut(local, ["stash", "list"])).toContain(
      "pwrgit: auto-stash before pull"
    );
  }, 15_000);

  it("fetch succeeds when already up to date", async () => {
    const result = await fetchRemote(systemGit, cloneA);
    expect(result.ok).toBe(true);
  });

  it("pull refuses (not_fast_forward) when the branch has diverged", async () => {
    commit(cloneA, "h.txt", "c3 local on A");
    commit(cloneB, "i.txt", "c4 on B");
    git(cloneB, ["push"]);

    const result = await pullFastForward(systemGit, cloneA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_fast_forward");
  });

  it("explains a clean remote rewrite with matching commit messages", async () => {
    const { local, remote } = makeDivergedFixture();
    // Same patch + subject, distinct author identities: representative of the
    // new object IDs a remote rebase or force-push leaves behind.
    commit(local, "feature.txt", "feat: keep this change");
    commit(remote, "feature.txt", "feat: keep this change");
    git(remote, ["push"]);

    const pulled = await pullFastForward(systemGit, local);
    expect(pulled.ok).toBe(false);
    if (!pulled.ok) {
      expect(pulled.error.code).toBe("not_fast_forward");
      expect(pulled.error.message).toBe(
        "Your local branch and its upstream have diverged."
      );
    }

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;
    expect(divergence.value).toMatchObject({
      branch: "main",
      head: expect.any(String),
      upstream: "origin/main",
      workingTreeClean: true,
      matchingCommitSubjects: true
    });
    expect(divergence.value.localCommits).toEqual([
      { shortHash: expect.any(String), subject: "feat: keep this change" }
    ]);
    expect(divergence.value.upstreamCommits).toEqual([
      { shortHash: expect.any(String), subject: "feat: keep this change" }
    ]);
  }, 15_000);

  it("resets only a clean branch to the exact inspected upstream", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(local, "local.txt", "feat: local only");
    commit(remote, "remote.txt", "feat: remote only");
    git(remote, ["push"]);
    await pullFastForward(systemGit, local);

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;

    const stale = await resetToUpstream(systemGit, local, {
      ...recoverySnapshot(divergence.value),
      upstreamHead: "0".repeat(40)
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("upstream_changed");

    const reset = await resetToUpstream(
      systemGit,
      local,
      recoverySnapshot(divergence.value)
    );
    expect(reset.ok).toBe(true);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(
      divergence.value.upstreamHead
    );
  }, 15_000);

  it("does not reset a dirty worktree and can rebase non-conflicting local work", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(local, "local.txt", "feat: local only");
    commit(remote, "remote.txt", "feat: remote only");
    git(remote, ["push"]);
    await pullFastForward(systemGit, local);

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;

    writeFileSync(join(local, "untracked.txt"), "keep me\n");
    const dirty = await resetToUpstream(
      systemGit,
      local,
      recoverySnapshot(divergence.value)
    );
    expect(dirty.ok).toBe(false);
    if (!dirty.ok) expect(dirty.error.code).toBe("dirty");

    git(local, ["clean", "-fd"]);
    const rebased = await rebaseOntoUpstream(
      systemGit,
      local,
      recoverySnapshot(divergence.value)
    );
    expect(rebased.ok).toBe(true);
    expect(gitOut(local, ["log", "-1", "--format=%s"])).toBe(
      "feat: local only"
    );
    expect(gitOut(local, ["merge-base", "--is-ancestor", "origin/main", "HEAD"])).toBe(
      ""
    );
  }, 15_000);

  it("does not recover after the checked-out branch changes", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(local, "local.txt", "feat: local only");
    commit(remote, "remote.txt", "feat: remote only");
    git(remote, ["push"]);
    await pullFastForward(systemGit, local);

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;

    git(local, ["branch", "--track", "same-upstream", "origin/main"]);
    git(local, ["switch", "same-upstream"]);
    const switchedHead = gitOut(local, ["rev-parse", "HEAD"]);
    expect(switchedHead).toBe(divergence.value.upstreamHead);

    for (const recover of [resetToUpstream, rebaseOntoUpstream]) {
      const result = await recover(
        systemGit,
        local,
        recoverySnapshot(divergence.value)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("checkout_changed");
    }
    expect(gitOut(local, ["branch", "--show-current"])).toBe("same-upstream");
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(switchedHead);
  }, 15_000);
});
