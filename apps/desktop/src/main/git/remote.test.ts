import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  err,
  ok,
  REMOTE_BRANCH_PAGE_MAX,
  REMOTE_BRANCH_PREVIEW,
  type RemoteDivergence,
  type Result
} from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  addRemote,
  fetchAllRemotes,
  fetchNamedRemote,
  fetchRemote,
  inspectRemoteReset,
  inspectRemoteDivergence,
  listRemoteBranchPage,
  listRepoRefs,
  planPushRefs,
  pullFastForward,
  pushPlannedRefs,
  pushRemote,
  rebaseOntoUpstream,
  removeRemote,
  resetToUpstream,
  resetToRemote,
  resolveResetTargets,
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
function fileText(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8").replaceAll("\r\n", "\n");
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
/**
 * Commit on a fixed date (`YYYY-MM-DD`). `for-each-ref --sort=-committerdate`
 * has no defined tie-break within one second, so any test asserting ref order
 * has to pin the dates rather than race the wall clock.
 */
function commitAt(dir: string, file: string, msg: string, date: string): void {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, ["add", "."]);
  const stamp = `${date}T12:00:00Z`;
  execFileSync("git", ["commit", "-m", msg], {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp
    }
  });
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

function makeUnbornTrackedFixture(): { local: string; upstreamHead: string } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-unborn-"));
  git(root, ["init", "--bare", "-b", "main", "origin.git"]);

  const remote = join(root, "remote");
  git(root, ["clone", "origin.git", "remote"]);
  configure(remote, "remote");
  commit(remote, "base.txt", "base");
  git(remote, ["push", "-u", "origin", "main"]);

  const local = join(root, "local");
  git(root, ["init", "-b", "main", "local"]);
  configure(local, "local");
  git(local, ["remote", "add", "origin", join(root, "origin.git")]);
  git(local, ["config", "branch.main.remote", "origin"]);
  git(local, ["config", "branch.main.merge", "refs/heads/main"]);
  return { local, upstreamHead: gitOut(remote, ["rev-parse", "HEAD"]) };
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
    const phases: string[] = [];
    const result = await pullFastForward(systemGit, cloneA, (phase) =>
      phases.push(phase)
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fastForwarded).toBe(true);
    expect(phases).toEqual(["fetch", "prepare", "fast_forward"]);
    expect(existsSync(join(cloneA, "g.txt"))).toBe(true);
  });

  it("pulls a tracked unborn branch", async () => {
    const { local, upstreamHead } = makeUnbornTrackedFixture();
    expect(() =>
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: local,
        stdio: "ignore"
      })
    ).toThrow();

    const phases: string[] = [];
    const result = await pullFastForward(systemGit, local, (phase) =>
      phases.push(phase)
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        fastForwarded: true,
        stashed: false,
        reappliedWithConflicts: false
      });
    }
    expect(phases).toEqual(["fetch", "prepare", "fast_forward"]);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(upstreamHead);
    expect(fileText(local, "base.txt")).toBe("base.txt\n");
  }, 15_000);

  it("restores an unborn checkout after a partial merge failure", async () => {
    const { local } = makeUnbornTrackedFixture();
    let sawPartialMutation = false;
    const failAfterPartialCheckout: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        git(cwd, ["checkout", "origin/main", "--", "base.txt"]);
        sawPartialMutation =
          existsSync(join(cwd, "base.txt")) &&
          gitOut(cwd, ["diff", "--cached", "--name-only"]) === "base.txt";
        return ok({
          stdout: "",
          stderr: "simulated merge checkout failure",
          exitCode: 128
        });
      }
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failAfterPartialCheckout, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("merge_failed");
    expect(sawPartialMutation).toBe(true);
    expect(() =>
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: local,
        stdio: "ignore"
      })
    ).toThrow();
    expect(gitOut(local, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(local, "base.txt"))).toBe(false);
  }, 15_000);

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
          fileText(cwd, "base.txt") === "upstream version\n" &&
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
          fileText(cwd, "base.txt") === "base.txt\n" &&
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
    expect(fileText(local, "base.txt")).toBe(
      "staged work\nunstaged work\n"
    );
    expect(fileText(local, "untracked.txt")).toBe("keep me\n");
    expect(existsSync(join(local, "upstream.txt"))).toBe(false);
    expect(gitOut(local, ["status", "--porcelain"])).toBe(originalStatus);
    expect(gitOut(local, ["diff", "--cached"])).toBe(originalStagedDiff);
    expect(gitOut(local, ["diff"])).toBe(originalUnstagedDiff);
    expect(gitOut(local, ["stash", "list"])).toBe("");
  }, 15_000);

  it("removes partial untracked checkout artifacts before restoring a clean checkout", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(remote, "upstream.txt", "advance upstream");
    git(remote, ["push"]);

    const originalHead = gitOut(local, ["rev-parse", "HEAD"]);
    let sawPartialArtifact = false;
    const failAfterUntrackedCheckout: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        writeFileSync(join(cwd, "upstream.txt"), "partial upstream checkout\n");
        sawPartialArtifact =
          existsSync(join(cwd, "upstream.txt")) &&
          gitOut(cwd, ["status", "--porcelain"]) === "?? upstream.txt";
        return ok({
          stdout: "",
          stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
          exitCode: 128
        });
      }
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failAfterUntrackedCheckout, local);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("merge_failed");
      expect(result.error.message).toContain("terminal prompts disabled");
    }
    expect(sawPartialArtifact).toBe(true);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(gitOut(local, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(local, "upstream.txt"))).toBe(false);
  }, 15_000);

  it("preserves an unrelated untracked file created while a failed pull is running", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(remote, "upstream.txt", "advance upstream");
    git(remote, ["push"]);

    const originalHead = gitOut(local, ["rev-parse", "HEAD"]);
    const failAfterConcurrentWrite: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        writeFileSync(join(cwd, "upstream.txt"), "partial upstream checkout\n");
        writeFileSync(join(cwd, "generated-during-pull.txt"), "keep me\n");
        return ok({
          stdout: "",
          stderr: "simulated checkout failure",
          exitCode: 128
        });
      }
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failAfterConcurrentWrite, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("merge_failed");
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(existsSync(join(local, "upstream.txt"))).toBe(false);
    expect(fileText(local, "generated-during-pull.txt")).toBe("keep me\n");
    expect(gitOut(local, ["status", "--porcelain"])).toBe(
      "?? generated-during-pull.txt"
    );
  }, 15_000);

  it("treats incoming cleanup paths as literals instead of pathspec magic", async () => {
    const { local, remote } = makeDivergedFixture();
    // Bracket expressions are valid Git pathspec magic and valid filenames on
    // Windows. Without literal pathspec handling, this also matches "p.txt".
    const magicPath = "[partial].txt";
    commit(remote, magicPath, "add pathspec-shaped filename");
    git(remote, ["push"]);

    const failAfterConcurrentWrite: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        writeFileSync(join(cwd, magicPath), "partial upstream checkout\n");
        writeFileSync(join(cwd, "p.txt"), "keep me\n");
        return ok({
          stdout: "",
          stderr: "simulated checkout failure",
          exitCode: 128
        });
      }
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failAfterConcurrentWrite, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("merge_failed");
    expect(existsSync(join(local, magicPath))).toBe(false);
    expect(fileText(local, "p.txt")).toBe("keep me\n");
  }, 15_000);

  it("cleans a partial checkout before reapplying an untracked file with the same path", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(remote, "upstream.txt", "advance upstream");
    git(remote, ["push"]);

    const originalHead = gitOut(local, ["rev-parse", "HEAD"]);
    writeFileSync(join(local, "upstream.txt"), "local untracked work\n");
    const originalStatus = gitOut(local, ["status", "--porcelain"]);
    let sawPartialArtifact = false;
    let cleanBeforePop = false;
    const failAfterUntrackedCheckout: GitExec = async (args, cwd, options) => {
      if (args[0] === "merge") {
        writeFileSync(join(cwd, "upstream.txt"), "partial upstream checkout\n");
        sawPartialArtifact =
          fileText(cwd, "upstream.txt") === "partial upstream checkout\n";
        return ok({
          stdout: "",
          stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
          exitCode: 128
        });
      }
      if (args[0] === "stash" && args[1] === "pop") {
        cleanBeforePop = !existsSync(join(cwd, "upstream.txt"));
      }
      return systemGit(args, cwd, options);
    };

    const result = await pullFastForward(failAfterUntrackedCheckout, local);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("merge_failed");
      expect(result.error.message).toContain("terminal prompts disabled");
    }
    expect(sawPartialArtifact).toBe(true);
    expect(cleanBeforePop).toBe(true);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(gitOut(local, ["status", "--porcelain"])).toBe(originalStatus);
    expect(fileText(local, "upstream.txt")).toBe("local untracked work\n");
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

    const phases: string[] = [];
    const result = await pullFastForward(systemGit, local, (phase) =>
      phases.push(phase)
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        fastForwarded: true,
        stashed: true,
        reappliedWithConflicts: false
      });
    }
    expect(phases).toEqual([
      "fetch",
      "prepare",
      "fast_forward",
      "reapply"
    ]);
    expect(existsSync(join(local, "upstream.txt"))).toBe(true);
    expect(gitOut(local, ["status", "--porcelain"])).toBe(originalStatus);
    expect(gitOut(local, ["diff", "--cached"])).toBe(originalStagedDiff);
    expect(gitOut(local, ["diff"])).toBe(originalUnstagedDiff);
    expect(fileText(local, "untracked.txt")).toBe("keep me\n");
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
    expect(fileText(local, "base.txt")).toContain("<<<<<<<");
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
    expect(fileText(local, "base.txt")).toBe("local work\n");
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

  it.each([
    {
      name: "the configured remote",
      fetch: (git: GitExec) => fetchRemote(git, "/repos/project"),
      args: ["fetch", "--prune"]
    },
    {
      name: "a named remote",
      fetch: (git: GitExec) =>
        fetchNamedRemote(git, "/repos/project", "origin"),
      args: ["fetch", "--prune", "origin"]
    },
    {
      name: "all remotes",
      fetch: (git: GitExec) => fetchAllRemotes(git, "/repos/project"),
      args: ["fetch", "--all", "--prune"]
    }
  ])(
    "retries $name when another process updates a ref first",
    async ({ fetch, args }) => {
      const calls: string[][] = [];
      const racingGit: GitExec = async (actualArgs) => {
        calls.push(actualArgs);
        return ok(
          calls.length === 1
            ? {
                stdout: "",
                stderr:
                  "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
                exitCode: 1
              }
            : { stdout: "", stderr: "", exitCode: 0 }
        );
      };

      await expect(fetch(racingGit)).resolves.toEqual(ok(undefined));
      expect(calls).toEqual([args, args]);
    }
  );

  it("also retries Git's cannot-lock stale-value form", async () => {
    let attempts = 0;
    const racingGit: GitExec = async () => {
      attempts += 1;
      return ok(
        attempts === 1
          ? {
              stdout: "",
              stderr:
                "error: cannot lock ref 'refs/remotes/origin/main': is at 8fa2455 but expected 625e993",
              exitCode: 1
            }
          : { stdout: "", stderr: "", exitCode: 0 }
      );
    };

    await expect(fetchRemote(racingGit, "/repos/project")).resolves.toEqual(
      ok(undefined)
    );
    expect(attempts).toBe(2);
  });

  it("does not retry an unrelated fetch failure", async () => {
    let attempts = 0;
    const failingGit: GitExec = async () => {
      attempts += 1;
      return ok({
        stdout: "",
        stderr: "fatal: Authentication failed",
        exitCode: 128
      });
    };

    const result = await fetchRemote(failingGit, "/repos/project");
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("stops after one stale-ref retry", async () => {
    let attempts = 0;
    const racingGit: GitExec = async () => {
      attempts += 1;
      return ok({
        stdout: "",
        stderr: "error: incorrect old value provided",
        exitCode: 1
      });
    };

    const result = await fetchRemote(racingGit, "/repos/project");
    expect(result.ok).toBe(false);
    expect(attempts).toBe(2);
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
      {
        hash: expect.any(String),
        shortHash: expect.any(String),
        subject: "feat: keep this change",
        additions: 1,
        deletions: 0
      }
    ]);
    expect(divergence.value.upstreamCommits).toEqual([
      {
        hash: expect.any(String),
        shortHash: expect.any(String),
        subject: "feat: keep this change",
        additions: 1,
        deletions: 0
      }
    ]);
    expect(divergence.value.alignedCommits).toEqual([
      {
        local: divergence.value.localCommits[0],
        upstream: divergence.value.upstreamCommits[0],
        relation: "changed"
      }
    ]);
  }, 15_000);

  it("aligns a rewritten series while preserving commits unique to both sides", async () => {
    const { local, remote } = makeDivergedFixture();
    for (let index = 0; index < 10; index += 1) {
      const file = `shared-${index}.txt`;
      const subject = `feat: shared change ${index}`;
      commit(local, file, subject);
      commit(remote, file, subject);
    }
    commit(local, "local-0.txt", "feat: local only 0");
    commit(local, "local-1.txt", "feat: local only 1");
    commit(remote, "remote-0.txt", "feat: remote only 0");
    commit(remote, "remote-1.txt", "feat: remote only 1");
    commit(remote, "remote-2.txt", "feat: remote only 2");
    git(remote, ["push"]);
    await pullFastForward(systemGit, local);

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;

    expect(divergence.value.localCommits).toHaveLength(12);
    expect(divergence.value.upstreamCommits).toHaveLength(13);
    expect(divergence.value.alignedCommits).toHaveLength(15);
    expect(
      divergence.value.alignedCommits.filter(
        (row) => row.relation === "changed"
      )
    ).toHaveLength(10);
    expect(
      divergence.value.alignedCommits.filter(
        (row) => row.relation === "local-only"
      )
    ).toHaveLength(2);
    expect(
      divergence.value.alignedCommits.filter(
        (row) => row.relation === "upstream-only"
      )
    ).toHaveLength(3);
    const aligned = divergence.value.alignedCommits.find(
      (row) => row.local?.subject === "feat: shared change 7"
    );
    expect(aligned).toMatchObject({
      relation: "changed",
      local: { subject: "feat: shared change 7", additions: 1, deletions: 0 },
      upstream: { subject: "feat: shared change 7", additions: 1, deletions: 0 }
    });
  }, 15_000);

  it("marks recreated patches as equivalent even when their commit IDs differ", async () => {
    const { local, remote } = makeDivergedFixture();
    configure(remote, "local");
    commit(local, "shared.txt", "feat: shared patch");
    commit(remote, "remote-base.txt", "chore: upstream base");
    commit(remote, "shared.txt", "feat: shared patch");
    git(remote, ["push"]);
    await pullFastForward(systemGit, local);

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;
    const equivalent = divergence.value.alignedCommits.find(
      (row) => row.relation === "equivalent"
    );
    expect(equivalent).toMatchObject({
      local: { subject: "feat: shared patch", additions: 1, deletions: 0 },
      upstream: { subject: "feat: shared patch", additions: 1, deletions: 0 }
    });
    expect(equivalent?.local?.hash).not.toBe(equivalent?.upstream?.hash);
  }, 15_000);

  it("keeps a local merge commit that range-diff omits", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(remote, "shared.txt", "feat: shared remote change");
    git(remote, ["push"]);
    git(local, ["fetch", "origin"]);
    git(local, [
      "merge",
      "--no-ff",
      "origin/main",
      "-m",
      "merge: local upstream snapshot"
    ]);
    commit(remote, "later.txt", "feat: later remote change");
    git(remote, ["push"]);
    await pullFastForward(systemGit, local);

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;

    expect(divergence.value.localCommits.map((commit) => commit.subject)).toEqual([
      "merge: local upstream snapshot"
    ]);
    expect(
      divergence.value.alignedCommits
        .map((row) => row.local)
        .filter((commit) => commit !== null)
        .map((commit) => commit.hash)
    ).toEqual(divergence.value.localCommits.map((commit) => commit.hash));
    expect(divergence.value.alignedCommits).toContainEqual({
      local: divergence.value.localCommits[0],
      upstream: null,
      relation: "local-only"
    });
  }, 15_000);

  it("keeps an upstream merge commit that range-diff omits", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(local, "shared.txt", "feat: shared local change");
    git(local, ["push"]);
    git(remote, ["fetch", "origin"]);
    git(remote, [
      "merge",
      "--no-ff",
      "origin/main",
      "-m",
      "merge: upstream local snapshot"
    ]);
    commit(local, "later.txt", "feat: later local change");
    git(remote, ["push"]);
    await pullFastForward(systemGit, local);

    const divergence = await inspectRemoteDivergence(systemGit, local);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;

    expect(
      divergence.value.upstreamCommits.map((commit) => commit.subject)
    ).toEqual(["merge: upstream local snapshot"]);
    expect(
      divergence.value.alignedCommits
        .map((row) => row.upstream)
        .filter((commit) => commit !== null)
        .map((commit) => commit.hash)
    ).toEqual(divergence.value.upstreamCommits.map((commit) => commit.hash));
    expect(divergence.value.alignedCommits).toContainEqual({
      local: null,
      upstream: divergence.value.upstreamCommits[0],
      relation: "upstream-only"
    });
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

  it("soft-resets to the exact fetched tip without changing index or worktree", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(local, "local.txt", "local commit");
    commit(remote, "remote.txt", "remote commit");
    git(remote, ["push"]);
    git(local, ["fetch", "origin"]);

    writeFileSync(join(local, "staged.txt"), "staged work\n");
    git(local, ["add", "staged.txt"]);
    writeFileSync(join(local, "base.txt"), "unstaged work\n");
    writeFileSync(join(local, "untracked.txt"), "untracked work\n");

    const inspected = await inspectRemoteReset(
      systemGit,
      local,
      "refs/remotes/origin/main"
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const reset = await resetToRemote(
      systemGit,
      local,
      inspected.value.snapshot,
      "soft"
    );

    expect(reset.ok).toBe(true);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(
      inspected.value.snapshot.remoteHead
    );
    expect(existsSync(join(local, "local.txt"))).toBe(true);
    expect(existsSync(join(local, "staged.txt"))).toBe(true);
    expect(existsSync(join(local, "untracked.txt"))).toBe(true);
    const statusAfter = gitOut(local, ["status", "--porcelain"]);
    expect(statusAfter).toContain("M base.txt");
    expect(statusAfter).toContain("A  staged.txt");
    expect(statusAfter).toContain("?? untracked.txt");
  }, 15_000);

  it("hard-resets tracked state but does not clean ordinary untracked or ignored files", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(local, "local.txt", "local commit");
    commit(remote, "remote.txt", "remote commit");
    git(remote, ["push"]);
    git(local, ["fetch", "origin"]);

    writeFileSync(join(local, "staged.txt"), "staged work\n");
    git(local, ["add", "staged.txt"]);
    writeFileSync(join(local, "base.txt"), "unstaged work\n");
    writeFileSync(join(local, "untracked.txt"), "untracked work\n");
    writeFileSync(join(local, ".git", "info", "exclude"), "ignored.txt\n");
    writeFileSync(join(local, "ignored.txt"), "ignored work\n");

    const inspected = await inspectRemoteReset(
      systemGit,
      local,
      "refs/remotes/origin/main"
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const reset = await resetToRemote(
      systemGit,
      local,
      inspected.value.snapshot,
      "hard"
    );

    expect(reset.ok).toBe(true);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(
      inspected.value.snapshot.remoteHead
    );
    expect(existsSync(join(local, "remote.txt"))).toBe(true);
    expect(existsSync(join(local, "local.txt"))).toBe(false);
    expect(existsSync(join(local, "staged.txt"))).toBe(false);
    expect(existsSync(join(local, "untracked.txt"))).toBe(true);
    expect(existsSync(join(local, "ignored.txt"))).toBe(true);
  }, 15_000);

  it("rejects stale checkouts, changed fetched refs, and non-remote targets", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(remote, "remote.txt", "remote commit");
    git(remote, ["push"]);
    git(local, ["fetch", "origin"]);

    const inspected = await inspectRemoteReset(
      systemGit,
      local,
      "refs/remotes/origin/main"
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;

    commit(local, "local.txt", "checkout moved");
    const staleCheckout = await resetToRemote(
      systemGit,
      local,
      inspected.value.snapshot,
      "soft"
    );
    expect(staleCheckout.ok).toBe(false);
    if (!staleCheckout.ok) {
      expect(staleCheckout.error.code).toBe("checkout_changed");
    }

    const fresh = await inspectRemoteReset(
      systemGit,
      local,
      "refs/remotes/origin/main"
    );
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    commit(remote, "new-remote.txt", "remote moved again");
    git(remote, ["push"]);
    git(local, ["fetch", "origin"]);
    const staleRemote = await resetToRemote(
      systemGit,
      local,
      fresh.value.snapshot,
      "hard"
    );
    expect(staleRemote.ok).toBe(false);
    if (!staleRemote.ok) {
      expect(staleRemote.error.code).toBe("remote_ref_changed");
    }

    for (const invalid of [
      "main",
      "refs/heads/main",
      "HEAD",
      "refs/remotes/origin/HEAD"
    ]) {
      const result = await inspectRemoteReset(systemGit, local, invalid);
      expect(result.ok, invalid).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_remote_ref");
    }
  }, 15_000);
});

/**
 * A repository with more remote-tracking branches than any surface renders at
 * once — the shape that made `repo:refs` ship a megabyte of JSON. `origin`
 * carries twelve branches with strictly increasing committer dates so ordering
 * is assertable; `fork` carries two, so scoping is too.
 */
function makePagedRemoteFixture(): { local: string; names: string[] } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-paged-refs-"));
  for (const remote of ["origin", "fork"]) {
    git(root, ["init", "--bare", "-b", "main", `${remote}.git`]);
  }
  const local = join(root, "local");
  git(root, ["init", "-b", "main", "local"]);
  configure(local, "local");
  // Every commit here gets a pinned date. Leaving `main`'s to the wall clock
  // would make it the newest ref in the repository and quietly reorder the
  // listings these tests assert on.
  commitAt(local, "base.txt", "base", "2023-01-01");
  for (const remote of ["origin", "fork"]) {
    git(local, ["remote", "add", remote, join(root, `${remote}.git`)]);
  }
  git(local, ["push", "origin", "main"]);

  // Newest last, so the expected order is the reverse of this list.
  const names: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const name = `feature/page-${String(index).padStart(2, "0")}`;
    names.push(name);
    git(local, ["switch", "-c", name, "main"]);
    commitAt(
      local,
      `${index}.txt`,
      `add widget number ${index}`,
      `2024-01-${String(index).padStart(2, "0")}`
    );
    git(local, ["push", "origin", name]);
  }
  git(local, ["switch", "main"]);
  git(local, ["push", "fork", `${names[0]}:${names[0]}`]);
  git(local, ["push", "fork", `${names[1]}:${names[1]}`]);
  // A branch whose last segment is HEAD — legal, and not the symbolic pointer.
  git(local, ["push", "fork", `${names[0]}:spike/HEAD`]);

  // A remote whose OWN name contains a slash. git accepts this, and it makes
  // `refs/remotes/team/fork/<branch>` ambiguous to anything that splits on the
  // first slash.
  git(root, ["init", "--bare", "-b", "main", "team-fork.git"]);
  git(local, ["remote", "add", "team/fork", join(root, "team-fork.git")]);
  git(local, ["push", "team/fork", "main:main"]);
  git(local, ["push", "team/fork", `${names[0]}:${names[0]}`]);

  // Every local feature branch is deleted, so `refs/remotes` is the only source.
  for (const name of names) git(local, ["branch", "-D", name]);
  git(local, ["fetch", "--all"]);
  git(local, ["remote", "set-head", "origin", "main"]);
  git(local, ["remote", "set-head", "team/fork", "main"]);
  return { local, names };
}

describe("listRemoteBranchPage (paged remote refs)", () => {
  let fixture: { local: string; names: string[] };

  beforeAll(() => {
    fixture = makePagedRemoteFixture();
  }, 60_000);

  it("returns one page and the full match count, newest commit first", async () => {
    const page = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      limit: 5
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // 12 features + main, and NOT origin/HEAD.
    expect(page.value.total).toBe(13);
    expect(page.value.rows).toHaveLength(5);
    expect(page.value.rows.map((row) => row.name)).toEqual([
      "feature/page-12",
      "feature/page-11",
      "feature/page-10",
      "feature/page-09",
      "feature/page-08"
    ]);
    expect(page.value.rows[0]).toMatchObject({
      qualifiedName: "origin/feature/page-12",
      fullName: "refs/remotes/origin/feature/page-12",
      subject: "add widget number 12"
    });
  }, 20_000);

  it("walks the whole remote through offsets without repeating a ref", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 13; offset += 5) {
      const page = await listRemoteBranchPage(systemGit, fixture.local, {
        remote: "origin",
        offset,
        limit: 5
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      seen.push(...page.value.rows.map((row) => row.fullName));
    }
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    // Past the end is empty, not an error and not a wrap-around.
    const past = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      offset: 99
    });
    expect(past.ok).toBe(true);
    if (past.ok) {
      expect(past.value.rows).toEqual([]);
      expect(past.value.total).toBe(13);
    }
  }, 20_000);

  it("filters on qualified name and on commit subject", async () => {
    const byName = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      query: "page-07"
    });
    expect(byName.ok).toBe(true);
    if (byName.ok) {
      expect(byName.value.total).toBe(1);
      expect(byName.value.rows[0]?.name).toBe("feature/page-07");
    }

    // The subject is the only place "widget number 3" appears.
    const bySubject = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      query: "widget number 3"
    });
    expect(bySubject.ok).toBe(true);
    if (bySubject.ok) {
      expect(bySubject.value.rows.map((row) => row.name)).toEqual([
        "feature/page-03"
      ]);
    }

    const caseInsensitive = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      query: "FEATURE/PAGE-05"
    });
    expect(caseInsensitive.ok).toBe(true);
    if (caseInsensitive.ok) expect(caseInsensitive.value.total).toBe(1);

    const miss = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      query: "no-such-branch"
    });
    expect(miss.ok).toBe(true);
    if (miss.ok) {
      expect(miss.value.total).toBe(0);
      expect(miss.value.rows).toEqual([]);
    }
  }, 20_000);

  it("scopes to one remote, and searches every remote when unscoped", async () => {
    const fork = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "fork"
    });
    expect(fork.ok).toBe(true);
    if (fork.ok) {
      // page-01, page-02, spike/HEAD.
      expect(fork.value.total).toBe(3);
      expect(fork.value.rows.every((row) => row.qualifiedName.startsWith("fork/"))).toBe(
        true
      );
    }

    const all = await listRemoteBranchPage(systemGit, fixture.local, {});
    expect(all.ok).toBe(true);
    if (all.ok) {
      // 13 on origin + 3 on fork + 2 on team/fork, every symbolic HEAD excluded.
      expect(all.value.total).toBe(18);
      expect(
        all.value.rows.some((row) => row.qualifiedName === "fork/feature/page-01")
      ).toBe(true);
    }
  }, 20_000);

  it("never returns the remote's symbolic HEAD as a branch", async () => {
    // The fixture set origin/HEAD, so the ref exists and must be filtered out.
    expect(gitOut(fixture.local, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe(
      "refs/remotes/origin/main"
    );
    const page = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      limit: 200
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.rows.some((row) => row.name === "HEAD")).toBe(false);
    expect(
      page.value.rows.some((row) => row.fullName.endsWith("/HEAD"))
    ).toBe(false);
  }, 20_000);

  it("accepts only names the repository actually has as remotes", async () => {
    // Membership in the configured remotes is the guard, so an option-looking
    // argument can never reach `for-each-ref` argv.
    for (const invalid of ["--sort=-refname", "-x", "origin/main", "a b", "nope"]) {
      const result = await listRemoteBranchPage(systemGit, fixture.local, {
        remote: invalid
      });
      expect(result.ok, invalid).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_remote");
    }
  }, 20_000);

  it("handles a remote whose own name contains a slash", async () => {
    // `git remote add team/fork` is legal, and yields refs shaped
    // `refs/remotes/team/fork/<branch>`. Splitting on the first slash would
    // read that as remote "team", branch "fork/<branch>".
    const scoped = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "team/fork"
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    // main + feature/page-01, newest commit first, and NOT team/fork/HEAD.
    expect(scoped.value.rows.map((row) => row.name)).toEqual([
      "feature/page-01",
      "main"
    ]);
    expect(scoped.value.rows[0]).toMatchObject({
      name: "feature/page-01",
      qualifiedName: "team/fork/feature/page-01",
      fullName: "refs/remotes/team/fork/feature/page-01"
    });

    // Unscoped has to reach the same split without being told the remote.
    const all = await listRemoteBranchPage(systemGit, fixture.local, {
      query: "team/fork",
      limit: REMOTE_BRANCH_PAGE_MAX
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.rows.map((row) => row.name)).toEqual([
      "feature/page-01",
      "main"
    ]);

    // …including its symbolic HEAD, which is `team/fork/HEAD` and not a branch.
    expect(
      gitOut(fixture.local, ["symbolic-ref", "refs/remotes/team/fork/HEAD"])
    ).toBe("refs/remotes/team/fork/main");
    const everything = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "team/fork",
      limit: REMOTE_BRANCH_PAGE_MAX
    });
    expect(everything.ok).toBe(true);
    if (everything.ok) {
      expect(everything.value.rows.some((row) => row.name === "HEAD")).toBe(false);
      expect(
        everything.value.rows.some((row) => row.fullName.endsWith("/HEAD"))
      ).toBe(false);
    }
  }, 20_000);

  it("treats a branch named feature/HEAD as a branch, in both counts", async () => {
    // Only the ref directly at `<remote>/HEAD` is the symbolic pointer. A
    // branch whose last segment is HEAD is an ordinary branch, and the sidebar
    // count and the paged total have to agree about it.
    const page = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "fork",
      limit: REMOTE_BRANCH_PAGE_MAX
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.rows.some((row) => row.name === "spike/HEAD")).toBe(true);

    const refs = await listRepoRefs(systemGit, fixture.local, new Map());
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    const fork = refs.value.remotes.find((remote) => remote.name === "fork");
    expect(fork?.branchCount).toBe(page.value.total);
  }, 20_000);

  it("caps an oversized limit instead of honouring it", async () => {
    const page = await listRemoteBranchPage(systemGit, fixture.local, {
      limit: 10_000
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.rows.length).toBeLessThanOrEqual(REMOTE_BRANCH_PAGE_MAX);
  }, 20_000);

  it("keeps repo:refs bounded: a preview per remote, plus a true total", async () => {
    const refs = await listRepoRefs(systemGit, fixture.local, new Map());
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    const origin = refs.value.remotes.find((remote) => remote.name === "origin");
    expect(origin).toBeDefined();
    if (origin === undefined) return;
    // The count is the whole remote; the payload is only the preview.
    expect(origin.branchCount).toBe(13);
    expect(origin.previewBranches).toHaveLength(REMOTE_BRANCH_PREVIEW);
    expect(origin.previewBranches.map((branch) => branch.name)).toEqual([
      "feature/page-12",
      "feature/page-11",
      "feature/page-10",
      "feature/page-09",
      "feature/page-08",
      "feature/page-07"
    ]);
    // The preview is a prefix of the paged listing, not a separate ordering.
    const page = await listRemoteBranchPage(systemGit, fixture.local, {
      remote: "origin",
      limit: REMOTE_BRANCH_PREVIEW
    });
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.rows.map((row) => row.fullName)).toEqual(
        origin.previewBranches.map((branch) => branch.fullName)
      );
    }
  }, 20_000);
});

describe("reset target ranking", () => {
  /**
   * The bug this pins: the picker seeded itself from a list sorted by
   * committer date across every remote, so an active trunk made `origin/main`
   * the default target for every branch in the repository — the one answer
   * that throws a feature branch away.
   */
  function makeFeatureBranchFixture(): { local: string; remote: string } {
    const { local, remote } = makeDivergedFixture();
    git(local, ["switch", "-c", "feature/media"]);
    commit(local, "media.txt", "feature commit");
    git(local, ["push", "-u", "origin", "feature/media"]);
    // Trunk moves last, so it is newest by committer date everywhere.
    commit(remote, "trunk.txt", "trunk commit");
    git(remote, ["push", "origin", "main"]);
    git(local, ["fetch", "origin"]);
    return { local, remote };
  }

  it("ranks the branch's own upstream first, not the newest remote branch", async () => {
    const { local } = makeFeatureBranchFixture();

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;

    expect(targets.value.branch).toBe("feature/media");
    expect(targets.value.upstream?.ref).toBe(
      "refs/remotes/origin/feature/media"
    );
    expect(targets.value.upstream?.label).toBe("origin/feature/media");
    expect(targets.value.defaultBranch?.label).toBe("origin/main");
    expect(targets.value.branchCount).toBe(2);
    expect(targets.value.lastFetchedAt).not.toBeNull();
  });

  it("counts each side of the divergence against the checkout", async () => {
    const { local, remote } = makeFeatureBranchFixture();
    commit(local, "local-only.txt", "local work");
    git(remote, ["fetch", "origin"]);
    git(remote, ["switch", "feature/media"]);
    commit(remote, "remote-1.txt", "remote work");
    commit(remote, "remote-2.txt", "more remote work");
    git(remote, ["push", "origin", "feature/media"]);
    git(local, ["fetch", "origin"]);

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.upstream).toMatchObject({ ahead: 1, behind: 2 });
  });

  it("opens on a branch with no upstream instead of failing", async () => {
    const { local } = makeDivergedFixture();
    git(local, ["fetch", "origin"]);
    git(local, ["switch", "-c", "local/only"]);
    commit(local, "solo.txt", "solo");

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.upstream).toBeNull();
    // The default branch is still worth naming — it is the other answer.
    expect(targets.value.defaultBranch?.label).toBe("origin/main");
  });

  it("does not offer the default branch twice when it is the upstream", async () => {
    const { local } = makeDivergedFixture();
    git(local, ["fetch", "origin"]);
    // Without a symbolic HEAD the null below would prove nothing.
    expect(gitOut(local, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe(
      "refs/remotes/origin/main"
    );

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.upstream?.label).toBe("origin/main");
    expect(targets.value.defaultBranch).toBeNull();
  });
});

describe("reset preview", () => {
  it("separates commits the target already carries from ones only here", async () => {
    const { local, remote } = makeDivergedFixture();
    // The same patch on both sides under different hashes — a rebase and
    // force-push, which an ahead/behind count reports as total loss.
    writeFileSync(join(local, "shared.txt"), "shared work\n");
    git(local, ["add", "shared.txt"]);
    git(local, ["commit", "-m", "shared change"]);
    commit(local, "only-here.txt", "never pushed");

    writeFileSync(join(remote, "shared.txt"), "shared work\n");
    git(remote, ["add", "shared.txt"]);
    git(remote, ["commit", "-m", "shared change"]);
    git(remote, ["push"]);
    git(local, ["fetch", "origin"]);

    const preview = await inspectRemoteReset(
      systemGit,
      local,
      "refs/remotes/origin/main"
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.value.leaving).toHaveLength(2);
    expect(preview.value.arriving).toHaveLength(1);
    expect(
      preview.value.alignedCommits.filter((row) => row.relation === "local-only")
    ).toHaveLength(1);
    expect(
      preview.value.alignedCommits.filter(
        (row) => row.local !== null && row.upstream !== null
      )
    ).toHaveLength(1);
  }, 15_000);

  it("reports the working-tree entries a hard reset would be weighed against", async () => {
    const { local, remote } = makeDivergedFixture();
    commit(remote, "remote.txt", "remote commit");
    git(remote, ["push"]);
    git(local, ["fetch", "origin"]);
    writeFileSync(join(local, "base.txt"), "unstaged work\n");
    writeFileSync(join(local, "untracked.txt"), "untracked work\n");

    const preview = await inspectRemoteReset(
      systemGit,
      local,
      "refs/remotes/origin/main"
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.dirty).toBe(2);
    expect(preview.value.snapshot.remoteRef).toBe("refs/remotes/origin/main");
  }, 15_000);
});
