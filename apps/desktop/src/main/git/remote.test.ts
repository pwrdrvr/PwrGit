import { execFileSync } from "node:child_process";
import { timedGitSync } from "./test-support/git-tripwire";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  err,
  ok,
  REMOTE_BRANCH_PAGE_MAX,
  REMOTE_BRANCH_PREVIEW,
  type RemoteDivergence
} from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import {
  addRemote,
  fetchAllRemotes,
  fetchHeadRemotes,
  fetchNamedRemote,
  fetchNamedRemotes,
  fetchRemote,
  forkFetchRemotes,
  forkSourceRemote,
  inspectRemoteReset,
  inspectRemoteDivergence,
  listRemoteBranchPage,
  listRemoteEndpoints,
  listRepoRefs,
  parseRepoRefRows,
  previewRemoteBranches,
  planPushRefs,
  pullFastForward,
  pushBranchWithLease,
  pushPlannedRefs,
  pushRemote,
  rebaseOntoUpstream,
  removeRemote,
  resetToUpstream,
  resetToRemote,
  resolveForkStatus,
  resolveResetTargets,
  updateRemote
} from "./git-service";
import { createSystemGit } from "./test-support/system-git";

const systemGit: GitExec = createSystemGit();

/** A GitExec that answers from a table keyed on the subcommand. */
function stubGit(
  answers: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>
): GitExec {
  return async (args) => {
    const answer = answers[args[0] ?? ""];
    if (answer === undefined) {
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    }
    return ok({
      stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "",
      exitCode: answer.exitCode ?? 0
    });
  };
}

describe("the push review reports what actually went wrong", () => {
  // Cancel is the standing case. Stopping the push kills Git, so every
  // remaining destination fails to READ its refs — which is not the same
  // answer as a ref that MOVED. Folding the two together told the user their
  // branch had changed underneath them and sent them back to re-review
  // something they had stopped themselves.
  it("does not call a failed ref read a ref that changed", async () => {
    const canceled: GitExec = async () =>
      err({
        kind: "git",
        code: "canceled",
        message: "Stopped at your request."
      });
    const pushed = await pushPlannedRefs(canceled, "/repo", [
      {
        sourceRef: "refs/heads/main",
        sourceLabel: "main",
        sourceHead: "a".repeat(40),
        destinationRemote: "origin",
        destinationBranch: "main",
        relation: "fast_forward"
      }
    ]);
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value[0]).toMatchObject({
      outcome: "failed",
      message: "Stopped at your request."
    });
  });

  // `--progress` is forced on every network command here so the activity
  // registry can read silence as evidence. Git writes that meter with CR, all
  // on one newline-delimited line, and the dialog shows `split("\n")[0]` — so
  // left alone the reason a fetch died is displaced by a wall of its own
  // progress.
  it("collapses Git's progress repaints out of a failed fetch", async () => {
    const planned = await planPushRefs(
      stubGit({
        remote: { stdout: "origin\n" },
        fetch: {
          exitCode: 128,
          stderr:
            "Receiving objects:   1%\rReceiving objects:  53%\rReceiving objects:  99%\n" +
            "fatal: the remote end hung up unexpectedly\n"
        }
      }),
      "/repo",
      "refs/heads/main",
      [{ remote: "origin", branch: "main" }]
    );
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    // What the dialog puts in front of the user.
    expect(planned.error.message.split("\n")[0]).toBe(
      "Receiving objects:  99%"
    );
    expect(planned.error.message).toContain(
      "fatal: the remote end hung up unexpectedly"
    );
  });
});

function git(dir: string, args: string[]): void {
  timedGitSync(args, dir, () => execFileSync("git", args, { cwd: dir, stdio: "ignore" }));
}
function gitOut(dir: string, args: string[]): string {
  return timedGitSync(args, dir, () => execFileSync("git", args, { cwd: dir, encoding: "utf8" })).trim();
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
  timedGitSync(["commit", "-m", msg], dir, () => execFileSync("git", ["commit", "-m", msg], {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp
    }
  }));
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
  });

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

  // The toolbar's Push on a branch with no upstream used to be a dead end: Git
  // refused and printed the `--set-upstream` command for the user to go and run
  // in a terminal. Publishing is that command, run for them — and the proof it
  // worked is not that the push exited 0 but that the branch now TRACKS
  // something, so the next plain Push has somewhere to go.
  it("publishes a branch with no upstream and tracks it from then on", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-publish-"));
    git(root, ["init", "--bare", "-b", "main", "origin.git"]);
    git(root, ["clone", "origin.git", "local"]);
    const local = join(root, "local");
    configure(local, "L");
    commit(local, "base.txt", "base");
    git(local, ["push", "-u", "origin", "main"]);
    git(local, ["checkout", "-b", "feature/new-thing"]);
    commit(local, "feature.txt", "unseen");

    const refused = await pushRemote(systemGit, local, true);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("no_upstream");

    const published = await pushRemote(systemGit, local, true, {
      remote: "origin"
    });
    expect(published.ok).toBe(true);
    expect(
      gitOut(local, ["rev-parse", "--abbrev-ref", "feature/new-thing@{upstream}"])
    ).toBe("origin/feature/new-thing");
    expect(
      gitOut(root, ["--git-dir", "origin.git", "rev-parse", "feature/new-thing"])
    ).toBe(gitOut(local, ["rev-parse", "HEAD"]));

    // And from here a plain Push just works. This is the half that rules out
    // publishing under a DIFFERENT name: Git's default `push.default=simple`
    // refuses a plain push whose upstream is named differently, so a renamed
    // publish creates a branch the Push button can never push to again.
    commit(local, "more.txt", "more");
    expect((await pushRemote(systemGit, local, true)).ok).toBe(true);
  });

  // A remote name is data. `git remote add -- -x` is accepted, and without a
  // `--` ahead of it Git reads the name as an option: probed, a remote named
  // `--dry-run` turned `push --set-upstream --dry-run HEAD` into a push to a
  // repository called HEAD.
  it("publishes to a remote whose name starts with a dash", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-dash-remote-"));
    git(root, ["init", "--bare", "-b", "main", "origin.git"]);
    git(root, ["init", "-b", "main", "local"]);
    const local = join(root, "local");
    configure(local, "L");
    commit(local, "base.txt", "base");
    git(local, ["remote", "add", "--", "--dry-run", join(root, "origin.git")]);

    const published = await pushRemote(systemGit, local, true, {
      remote: "--dry-run"
    });
    expect(published).toMatchObject({ ok: true });
    expect(
      gitOut(root, ["--git-dir", "origin.git", "rev-parse", "main"])
    ).toBe(gitOut(local, ["rev-parse", "HEAD"]));
  });

  it("names every remote and where a push to it goes, in one Git call", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-endpoints-"));
    git(root, ["init", "-b", "main", "local"]);
    const local = join(root, "local");
    git(local, ["remote", "add", "origin", "https://example.test/o.git"]);
    git(local, ["remote", "add", "fork", "https://example.test/f.git"]);
    git(local, ["remote", "set-url", "--push", "fork", "git@example.test:f.git"]);
    git(local, ["remote", "set-url", "--add", "--push", "fork", "git@example.test:g.git"]);
    const calls: string[][] = [];
    const counted: GitExec = (args, cwd) => {
      calls.push(args);
      return systemGit(args, cwd);
    };

    const endpoints = await listRemoteEndpoints(counted, local);
    expect(endpoints).toEqual(
      ok([
        // Git's own order. A remote with no push URL pushes where it fetches.
        {
          name: "fork",
          fetchUrl: "https://example.test/f.git",
          pushUrl: "git@example.test:f.git"
        },
        {
          name: "origin",
          fetchUrl: "https://example.test/o.git",
          pushUrl: "https://example.test/o.git"
        }
      ])
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses to publish to a remote that is gone", async () => {
    const missing = await pushRemote(systemGit, cloneB, true, {
      remote: "nowhere"
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "remote_missing" } });
  });

  // Measured in the real app: the card's headline read "Push failed — To
  // /private/var/…/svc.git", because Git's first stderr line on a rejection
  // is the destination. The reason sat collapsed in the output below it.
  it("leads a rejected push with the reason, not the destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-rejected-"));
    git(root, ["init", "--bare", "-b", "main", "origin.git"]);
    git(root, ["clone", "origin.git", "mine"]);
    const mine = join(root, "mine");
    configure(mine, "M");
    commit(mine, "base.txt", "base");
    git(mine, ["push", "-u", "origin", "main"]);
    git(root, ["clone", "origin.git", "theirs"]);
    const theirs = join(root, "theirs");
    configure(theirs, "T");
    commit(theirs, "theirs.txt", "theirs");
    git(theirs, ["push", "origin", "main"]);
    commit(mine, "mine.txt", "mine");

    const pushed = await pushRemote(systemGit, mine, true);
    expect(pushed.ok).toBe(false);
    if (pushed.ok) return;
    expect(pushed.error.code).toBe("rejected");
    expect(pushed.error.message).toBe(
      "The remote has newer commits. Pull, then push again."
    );
    // Git's own words ride beside it, for Copy and the evidence block — and
    // only Git's: the sentence above is PwrGit's, not something Git printed.
    expect(pushed.error.detail).toContain("[rejected]");
    expect(pushed.error.detail).not.toContain("Pull, then push again");
  });

  // Git's `fatal:` is usually a wrapper around the cause it printed just
  // before it. Ranking it first headlined each of these as the wrapper.
  it.each([
    [
      "an HTTPS denial",
      "remote: Permission to desktop/dugite.git denied to huntharo.\nfatal: unable to access 'https://github.com/desktop/dugite.git/': The requested URL returned error: 403",
      "remote: Permission to desktop/dugite.git denied to huntharo."
    ],
    [
      "an SSH key the server refused",
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
      "git@github.com: Permission denied (publickey)."
    ],
    [
      "a host that never answered",
      "ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.",
      "ssh: connect to host github.com port 22: Operation timed out"
    ],
    [
      "a server rule, behind progress and the destination",
      "Enumerating objects: 3, done.\nWriting objects: 100% (3/3), done.\nremote: \nremote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: \nTo github.com:o/r.git\n ! [remote rejected] main -> main (push declined due to repository rule violations)\nerror: failed to push some refs to 'github.com:o/r.git'",
      "remote: error: GH013: Repository rule violations found for refs/heads/main."
    ],
    [
      "a transport failure after the upload",
      "Enumerating objects: 9, done.\nCounting objects: 100% (9/9), done.\nWriting objects: 100% (9/9), 1.2 MiB, done.\nTotal 9 (delta 0), reused 0 (delta 0)\nerror: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\nfatal: the remote end hung up unexpectedly",
      "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413"
    ]
  ])("headlines %s with its cause, not Git's wrapper", async (_case, stderr, headline) => {
    const pushed = await pushRemote(
      stubGit({ push: { stderr, exitCode: 128 } }),
      "/unused"
    );
    expect(pushed).toMatchObject({ ok: false, error: { message: headline } });
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

  // Above the 20s global on purpose: 15 commits on each side plus the
  // range-diff over them, so this one test spawns `git` ~35 times.
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
  }, 45_000);

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });
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

  // `hookTimeout` has no global override, so this is measured against
  // Vitest's 10s default — far too tight for a fixture that pushes twelve
  // branches across three remotes.
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
  });

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
  });

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
  });

  it("matches origin's rows on their open change request, number first", async () => {
    const pr = (number: number, head: string) => ({
      number,
      url: `https://github.com/o/r/pull/${number}`,
      title: `feat: console rebuild ${number}`,
      state: "open" as const,
      isDraft: false,
      headRefName: head
    });
    // #6 heads page-06 on origin; the fork carries page-01 and page-02 under
    // the same names, and a same-named branch there is not origin's PR.
    const originPrs = new Map([
      ["feature/page-06", pr(6, "feature/page-06")],
      ["feature/page-01", pr(1, "feature/page-01")]
    ]);
    const byNumber = await listRemoteBranchPage(systemGit, fixture.local, {
      query: "6",
      originPrs
    });
    expect(byNumber.ok).toBe(true);
    if (!byNumber.ok) return;
    // Named by number: it leads, above rows whose names merely contain a 6.
    expect(byNumber.value.rows[0]).toMatchObject({
      qualifiedName: "origin/feature/page-06",
      pr: { number: 6 }
    });

    const byTitle = await listRemoteBranchPage(systemGit, fixture.local, {
      query: "console rebuild",
      originPrs
    });
    expect(byTitle.ok).toBe(true);
    if (!byTitle.ok) return;
    expect(byTitle.value.rows.map((row) => row.qualifiedName).sort()).toEqual([
      "origin/feature/page-01",
      "origin/feature/page-06"
    ]);
    expect(
      byTitle.value.rows.every((row) => row.qualifiedName.startsWith("origin/"))
    ).toBe(true);
  });

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
  });

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
  });

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
  });

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
  });

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
  });

  it("caps an oversized limit instead of honouring it", async () => {
    const page = await listRemoteBranchPage(systemGit, fixture.local, {
      limit: 10_000
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.rows.length).toBeLessThanOrEqual(REMOTE_BRANCH_PAGE_MAX);
  });

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
    // With no local counterpart among the newest six, the preview is still a
    // plain prefix of the paged listing — the ranking only ever moves a branch
    // the Branches section above already lists, and there is none here.
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
  });
});

/**
 * Which six of a remote's branches the sidebar disclosure spends its rows on.
 * Exercised directly rather than through a fixture repository: the input is one
 * `for-each-ref` listing and one set of local names, and building a repo whose
 * newest remote branches happen to shadow local heads is a lot of setup for a
 * pure ranking.
 */
describe("previewRemoteBranches", () => {
  const PREFIX = "refs/remotes/origin/";

  /** `for-each-ref` rows, newest committer date first — how they arrive. */
  function rows(...names: string[]) {
    return parseRepoRefRows(
      names
        .map(
          (name, index) =>
            `${PREFIX}${name}\torigin/${name}\t${String(index).repeat(40)}\t\t\t2026-09-0${index + 1}T00:00:00+00:00\tsubject ${name}`
        )
        .join("\n")
    );
  }

  it("is a plain prefix when nothing is shadowed", () => {
    const preview = previewRemoteBranches(
      rows("a", "b", "c"),
      PREFIX,
      new Set(["unrelated"])
    );
    expect(preview.map((b) => b.name)).toEqual(["a", "b", "c"]);
  });

  // The reported case: origin/main sits four rows under the local `main` that
  // tracks it, and the local row carries strictly more information.
  it("spends the slice on branches with no local counterpart", () => {
    const preview = previewRemoteBranches(
      rows("claude/x", "main", "dependabot/y", "fix/z", "codex/w", "feat/v", "fix/tray"),
      PREFIX,
      new Set(["main"])
    );
    expect(preview.map((b) => b.name)).toEqual([
      "claude/x",
      "dependabot/y",
      "fix/z",
      "codex/w",
      "feat/v",
      "fix/tray"
    ]);
  });

  // Ranked, not filtered: with nothing else to show, a shadowed branch is still
  // better than a blank row.
  it("still shows shadowed branches when they are all there is", () => {
    const preview = previewRemoteBranches(
      rows("main", "release"),
      PREFIX,
      new Set(["main", "release"])
    );
    expect(preview.map((b) => b.name)).toEqual(["main", "release"]);
  });

  // The bucketing is capped at the preview size, so a remote whose newest refs
  // are ALL shadowed must still fill six rows rather than come back short.
  it("fills the preview from shadowed branches when nothing else is left", () => {
    const preview = previewRemoteBranches(
      rows("m1", "m2", "m3", "m4", "m5", "m6", "m7", "solo"),
      PREFIX,
      new Set(["m1", "m2", "m3", "m4", "m5", "m6", "m7"])
    );
    expect(preview).toHaveLength(REMOTE_BRANCH_PREVIEW);
    expect(preview[0]?.name).toBe("solo");
    expect(preview.map((b) => b.name)).toEqual([
      "solo",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5"
    ]);
  });

  it("keeps committer-date order inside each group", () => {
    const preview = previewRemoteBranches(
      rows("mine-1", "theirs-1", "mine-2", "theirs-2"),
      PREFIX,
      new Set(["mine-1", "mine-2"])
    );
    expect(preview.map((b) => b.name)).toEqual([
      "theirs-1",
      "theirs-2",
      "mine-1",
      "mine-2"
    ]);
  });

  it("compares against the branch name, not the remote-qualified one", () => {
    // `origin/main` is never a local head; matching on it would make the
    // ranking a no-op and the defect silently survive.
    const preview = previewRemoteBranches(
      rows("main", "solo"),
      PREFIX,
      new Set(["main"])
    );
    expect(preview[0]?.name).toBe("solo");
  });

  it("never lists more than the preview budget", () => {
    const many = rows(...Array.from({ length: 9 }, (_, i) => `b${i}`));
    expect(previewRemoteBranches(many, PREFIX, new Set())).toHaveLength(
      REMOTE_BRANCH_PREVIEW
    );
  });
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

  /**
   * `git remote add team/fork` is legal, and `team` is a prefix of it. Picking
   * the upstream's owning remote in plain array order matched `team` first,
   * so the card read `refs/remotes/team/HEAD` — a different remote's trunk,
   * offered as the default branch for a branch tracking team/fork.
   */
  it("picks the longest matching remote name, not the first prefix", async () => {
    const { local, remote } = makeDivergedFixture();
    const fork = join(local, "..", "prefix-fork.git");
    git(remote, ["clone", "--bare", ".", fork]);
    // Written straight to config: `git remote add` refuses to hold a name and
    // a superset of it since 2.x, but a repository configured under an older
    // git still carries the pair, which is why `splitRemoteRef` guards it.
    git(local, ["config", "remote.team.url", remote]);
    git(local, [
      "config",
      "remote.team.fetch",
      "+refs/heads/*:refs/remotes/team/*"
    ]);
    git(local, ["config", "remote.team/fork.url", fork]);
    git(local, [
      "config",
      "remote.team/fork.fetch",
      "+refs/heads/*:refs/remotes/team/fork/*"
    ]);
    git(local, ["fetch", "team"]);
    git(local, ["fetch", "team/fork"]);
    git(local, ["remote", "set-head", "team", "main"]);
    git(local, ["remote", "set-head", "team/fork", "main"]);
    // `--set-upstream-to` refuses the ambiguity outright ("multiple remotes
    // whose fetch refspecs map to..."), which is the whole point: the pair can
    // only exist as config, so the tracking config is written the same way.
    const branch = gitOut(local, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(local, ["config", `branch.${branch}.remote`, "team/fork"]);
    git(local, ["config", `branch.${branch}.merge`, "refs/heads/main"]);
    expect(gitOut(local, ["rev-parse", "--symbolic-full-name", "@{u}"])).toBe(
      "refs/remotes/team/fork/main"
    );

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.upstream?.label).toBe("team/fork/main");
    // Its own remote's HEAD, deduped against the upstream — never team/main.
    expect(targets.value.defaultBranch).toBeNull();
    // origin/main, team/main, team/fork/main — both `<remote>/HEAD` pointers
    // drop out of the count, not just the one the short prefix would find.
    expect(targets.value.branchCount).toBe(3);
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

describe("reset targets on a fork", () => {
  /**
   * A fork checkout the way PwrGit's Fork leaves one: `origin` is the fork,
   * `upstream` the repository it was forked from, and `main` tracks
   * `origin/main`. `source` is a working clone of the original, for the
   * commits that land there after the fork was made.
   */
  function makeForkFixture(): { local: string; source: string; fork: string } {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-fork-"));
    git(root, ["init", "--bare", "-b", "main", "source.git"]);
    const source = join(root, "source");
    git(root, ["clone", "source.git", "source"]);
    configure(source, "source");
    commit(source, "base.txt", "base");
    git(source, ["push", "-u", "origin", "main"]);
    git(root, ["clone", "--bare", "source.git", "fork.git"]);
    const local = join(root, "local");
    // Set at clone time, before the checkout: Windows defaults autocrlf on,
    // and a test here reads a stashed edit back byte for byte.
    git(root, ["clone", "-c", "core.autocrlf=false", "fork.git", "local"]);
    configure(local, "local");
    git(local, ["remote", "add", "upstream", join(root, "source.git")]);
    git(local, ["fetch", "upstream"]);
    return { local, source, fork: join(root, "fork.git") };
  }

  /** Two merges land on the original after the fork was made. */
  function sourceMovesOn(source: string, local: string): void {
    commit(source, "upstream-1.txt", "upstream fix");
    commit(source, "upstream-2.txt", "another upstream fix");
    git(source, ["push", "origin", "main"]);
    git(local, ["fetch", "upstream"]);
  }

  // The reported case: `origin/main` identical to `main`, the source two
  // merges ahead, and the dialog opening on the no-op.
  it("offers the source's same branch, with a fast-forward back to the fork", async () => {
    const { local, source } = makeForkFixture();
    sourceMovesOn(source, local);

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;

    expect(targets.value.upstream).toMatchObject({
      label: "origin/main",
      remote: "origin",
      ahead: 0,
      behind: 0
    });
    expect(targets.value.forkSource).toMatchObject({
      ref: "refs/remotes/upstream/main",
      label: "upstream/main",
      remote: "upstream",
      ahead: 0,
      behind: 2,
      pushBack: {
        remote: "origin",
        branch: "main",
        ref: "refs/remotes/origin/main",
        head: gitOut(local, ["rev-parse", "origin/main"]),
        overwrites: 0,
        adds: 2
      }
    });
    // Chosen by its name alone, so nothing claims a forge relationship.
    expect(targets.value.forkSource?.parent).toBeUndefined();
  });

  it("names the parent when forge identity matched the remote to it", async () => {
    const { local, source } = makeForkFixture();
    sourceMovesOn(source, local);
    // A path is not a forge URL, so point a second remote somewhere that is,
    // and prove the match is by URL rather than by the name `upstream`.
    git(local, ["remote", "rename", "upstream", "original"]);
    git(local, [
      "remote",
      "set-url",
      "original",
      "git@github.com:Acme/Widget.git"
    ]);
    git(local, ["config", "remote.original.fetch", "+refs/heads/*:refs/remotes/original/*"]);
    git(local, [
      "update-ref",
      "refs/remotes/original/main",
      gitOut(source, ["rev-parse", "main"])
    ]);

    const targets = await resolveResetTargets(systemGit, local, {
      hostname: "github.com",
      nameWithOwner: "acme/widget"
    });
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.forkSource).toMatchObject({
      label: "original/main",
      parent: "acme/widget",
      behind: 2
    });
  });

  it("counts what a forced push would remove from a fork with commits of its own", async () => {
    const { local, source } = makeForkFixture();
    commit(local, "fork-only.txt", "ci: publish fork builds");
    git(local, ["push", "origin", "main"]);
    sourceMovesOn(source, local);

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.forkSource).toMatchObject({
      ahead: 1,
      behind: 2,
      pushBack: { overwrites: 1, adds: 2 }
    });
  });

  it("offers nothing to push when the fork already matches the source", async () => {
    const { local, source } = makeForkFixture();
    sourceMovesOn(source, local);
    // GitHub's "Sync fork" button, say: the fork moved, this checkout did not.
    git(local, ["push", "origin", "refs/remotes/upstream/main:refs/heads/main"]);
    git(local, ["fetch", "origin"]);

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.upstream).toMatchObject({ behind: 2 });
    expect(targets.value.forkSource).toMatchObject({
      behind: 2,
      pushBack: null
    });
  });

  it("finds the source's default branch under the name the source uses", async () => {
    const { local, source } = makeForkFixture();
    // The original renamed its trunk after the fork was made.
    git(source, ["branch", "-m", "main", "trunk"]);
    commit(source, "renamed.txt", "first commit on trunk");
    git(source, ["push", "origin", "trunk"]);
    // A bare repository refuses to delete the branch its HEAD names.
    git(join(source, ".."), [
      "--git-dir=source.git",
      "symbolic-ref",
      "HEAD",
      "refs/heads/trunk"
    ]);
    git(source, ["push", "origin", "--delete", "main"]);
    git(local, ["fetch", "--prune", "upstream"]);
    git(local, ["remote", "set-head", "upstream", "trunk"]);

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    expect(targets.value.forkSource).toMatchObject({
      ref: "refs/remotes/upstream/trunk",
      behind: 1
    });
  });

  it("leaves a feature branch alone when the source has no branch of that name", async () => {
    const { local, source } = makeForkFixture();
    sourceMovesOn(source, local);
    git(local, ["switch", "-c", "fix/drive-label"]);
    commit(local, "label.txt", "fix the label");
    git(local, ["push", "-u", "origin", "fix/drive-label"]);

    const targets = await resolveResetTargets(systemGit, local);
    expect(targets.ok).toBe(true);
    if (!targets.ok) return;
    // Not `upstream/main`: resetting a feature branch onto the trunk is never
    // a guess this dialog makes.
    expect(targets.value.forkSource).toBeNull();
  });

  // The other half of the report: "Last fetched moments ago" was true of
  // `origin` only, while the tip being reset to was nineteen minutes old.
  it("reports which remotes the last fetch asked, and fetches both on request", async () => {
    const { local } = makeForkFixture();
    git(local, ["fetch"]);

    const originOnly = await resolveResetTargets(systemGit, local);
    expect(originOnly.ok).toBe(true);
    if (!originOnly.ok) return;
    expect(originOnly.value.lastFetchedRemotes).toEqual(["origin"]);

    expect(
      (await fetchNamedRemotes(systemGit, local, ["upstream", "origin"])).ok
    ).toBe(true);
    const both = await resolveResetTargets(systemGit, local);
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.value.lastFetchedRemotes).toEqual(["origin", "upstream"]);
  });

  it("refuses to fetch a remote that is not configured", async () => {
    const { local } = makeForkFixture();
    const fetched = await fetchNamedRemotes(systemGit, local, ["--upload-pack=x"]);
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.error.code).toBe("remote_missing");
  });

  it("pushes the reset result to the fork, leased on the tip that was reviewed", async () => {
    const { local, source, fork } = makeForkFixture();
    sourceMovesOn(source, local);
    const reviewed = gitOut(local, ["rev-parse", "origin/main"]);
    const target = gitOut(local, ["rev-parse", "upstream/main"]);
    git(local, ["reset", "--soft", target]);

    const pushed = await pushBranchWithLease(systemGit, local, {
      remote: "origin",
      branch: "main",
      head: target,
      expectedHead: reviewed
    });
    expect(pushed.ok).toBe(true);
    expect(gitOut(fork, ["rev-parse", "main"])).toBe(target);
    // Pushed by remote name, so the tracking ref followed without a fetch.
    expect(gitOut(local, ["rev-parse", "origin/main"])).toBe(target);
  });

  it("replaces a diverged fork only while the lease still holds", async () => {
    const { local, source, fork } = makeForkFixture();
    commit(local, "fork-only.txt", "ci: publish fork builds");
    git(local, ["push", "origin", "main"]);
    sourceMovesOn(source, local);
    const reviewed = gitOut(local, ["rev-parse", "origin/main"]);
    const target = gitOut(local, ["rev-parse", "upstream/main"]);

    // Someone pushes to the fork after the review.
    const other = join(fork, "..", "other");
    git(join(fork, ".."), ["clone", "fork.git", "other"]);
    configure(other, "other");
    commit(other, "late.txt", "pushed after the review");
    git(other, ["push", "origin", "main"]);
    const moved = gitOut(fork, ["rev-parse", "main"]);

    const refused = await pushBranchWithLease(systemGit, local, {
      remote: "origin",
      branch: "main",
      head: target,
      expectedHead: reviewed
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("push_lease_stale");
    expect(gitOut(fork, ["rev-parse", "main"])).toBe(moved);

    // Leased on what is really there, the same push forces through.
    const forced = await pushBranchWithLease(systemGit, local, {
      remote: "origin",
      branch: "main",
      head: target,
      expectedHead: moved
    });
    expect(forced.ok).toBe(true);
    expect(gitOut(fork, ["rev-parse", "main"])).toBe(target);
  });

  it("reads a fork that has fallen behind its source, for the header chip", async () => {
    const { local, source } = makeForkFixture();
    sourceMovesOn(source, local);

    const status = await resolveForkStatus(systemGit, local, null);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value).toMatchObject({
      branch: "main",
      head: gitOut(local, ["rev-parse", "HEAD"]),
      source: {
        label: "upstream/main",
        remote: "upstream",
        ahead: 0,
        behind: 2,
        pushBack: { remote: "origin", branch: "main", overwrites: 0, adds: 2 }
      },
      // What the sync chip beside it reads, and why it says "up to date".
      tracked: { label: "origin/main", ahead: 0, behind: 0 },
      // The source's default IS this branch's counterpart: the chip reads
      // against it, so there is no drift to state as well.
      drift: null
    });
  });

  it("counts a fork's feature branch against the source's default branch", async () => {
    const { local, source } = makeForkFixture();
    git(local, ["switch", "-c", "fix/label-overflow"]);
    commit(local, "label.txt", "fix the label");
    git(local, ["push", "-u", "origin", "fix/label-overflow"]);
    sourceMovesOn(source, local);
    // A remote added after the clone has no HEAD until something sets it —
    // Fork in place adds `upstream` that way — so the source's default is
    // found under the name the fork's own remote uses for its default.
    // Git 2.48+ may have created one on fetch, so set it and then delete it.
    git(local, ["remote", "set-head", "upstream", "main"]);
    git(local, ["remote", "set-head", "upstream", "--delete"]);

    const status = await resolveForkStatus(systemGit, local, null);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value).toMatchObject({
      branch: "fix/label-overflow",
      // The source has no branch of that name: nothing to sync, no menu.
      source: null,
      tracked: { label: "origin/fix/label-overflow" },
      // Where the pull request lands, and the fork's own main cannot say it:
      // origin/main has not moved.
      drift: { label: "upstream/main", behind: 2 }
    });

    // A branch with no work of its own has nothing to say.
    git(local, ["switch", "-c", "empty", "main"]);
    const empty = await resolveForkStatus(systemGit, local, null);
    expect(empty.ok && empty.value?.drift).toEqual({
      label: "upstream/main",
      behind: 0
    });
  });

  it("has nothing to say without a fork source, or on a detached checkout", async () => {
    const { local, source } = makeForkFixture();
    sourceMovesOn(source, local);
    git(local, ["checkout", "--detach"]);
    const detached = await resolveForkStatus(systemGit, local, null);
    expect(detached).toEqual({ ok: true, value: null });

    git(local, ["checkout", "main"]);
    git(local, ["remote", "remove", "upstream"]);
    const plain = await resolveForkStatus(systemGit, local, null);
    expect(plain).toEqual({ ok: true, value: null });
  });

  it("fetches the fork's source alongside the branch's own remote", async () => {
    const { local } = makeForkFixture();
    expect(await forkFetchRemotes(systemGit, local, null)).toEqual([
      "origin",
      "upstream"
    ]);

    // A branch that tracks nothing keeps the plain fetch.
    git(local, ["switch", "-c", "draft"]);
    expect(await forkFetchRemotes(systemGit, local, null)).toBeNull();

    git(local, ["switch", "main"]);
    git(local, ["remote", "remove", "upstream"]);
    expect(await forkFetchRemotes(systemGit, local, null)).toBeNull();
  });

  it("fast-forwards to the fork's source the way Pull does, fetching it first", async () => {
    const { local, source } = makeForkFixture();
    // The source moves on and this checkout has not fetched it: the sync's
    // own fetch is what has to find the new commits.
    commit(source, "upstream-1.txt", "upstream fix");
    git(source, ["push", "origin", "main"]);
    writeFileSync(join(local, "base.txt"), "edited locally\n");

    const pulled = await pullFastForward(systemGit, local, undefined, {}, {
      kind: "ref",
      ref: "refs/remotes/upstream/main",
      label: "upstream/main",
      remotes: ["origin", "upstream"],
      branch: "main"
    });
    expect(pulled).toEqual({
      ok: true,
      value: { fastForwarded: true, stashed: true, reappliedWithConflicts: false }
    });
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(
      gitOut(source, ["rev-parse", "main"])
    );
    expect(readFileSync(join(local, "base.txt"), "utf8")).toBe("edited locally\n");
  });

  it("leaves a branch with commits of its own where it was", async () => {
    const { local, source } = makeForkFixture();
    commit(local, "mine.txt", "local work");
    sourceMovesOn(source, local);
    const before = gitOut(local, ["rev-parse", "HEAD"]);

    const pulled = await pullFastForward(systemGit, local, undefined, {}, {
      kind: "ref",
      ref: "refs/remotes/upstream/main",
      label: "upstream/main",
      remotes: ["upstream"],
      branch: "main"
    });
    expect(pulled.ok).toBe(false);
    if (pulled.ok) return;
    expect(pulled.error.code).toBe("not_fast_forward");
    expect(pulled.error.message).toContain("upstream/main");
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("compares a branch with commits of its own against the source, and rebases onto it", async () => {
    const { local, source } = makeForkFixture();
    commit(local, "mine.txt", "local work");
    sourceMovesOn(source, local);
    const sourceRef = "refs/remotes/upstream/main";

    const divergence = await inspectRemoteDivergence(systemGit, local, sourceRef);
    expect(divergence.ok).toBe(true);
    if (!divergence.ok) return;
    // Not the tracked branch: origin/main never moved, and has none of it.
    expect(divergence.value).toMatchObject({
      branch: "main",
      upstream: "upstream/main",
      upstreamHead: gitOut(local, ["rev-parse", sourceRef]),
      localCommits: [{ subject: "local work" }],
      upstreamCommits: [
        { subject: "another upstream fix" },
        { subject: "upstream fix" }
      ]
    });

    // The source moved after the review: refused, nothing rewritten.
    const before = gitOut(local, ["rev-parse", "HEAD"]);
    const stale = await rebaseOntoUpstream(
      systemGit,
      local,
      { ...divergence.value, upstreamHead: before },
      sourceRef
    );
    expect(stale.ok).toBe(false);
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(before);

    const rebased = await rebaseOntoUpstream(
      systemGit,
      local,
      divergence.value,
      sourceRef
    );
    expect(rebased).toEqual({ ok: true, value: undefined });
    expect(gitOut(local, ["rev-parse", "HEAD~1"])).toBe(
      divergence.value.upstreamHead
    );
    expect(gitOut(local, ["log", "-1", "--format=%s"])).toBe("local work");
  });

  it("refuses to fast-forward a branch other than the one it was offered for", async () => {
    const { local, source } = makeForkFixture();
    sourceMovesOn(source, local);
    const before = gitOut(local, ["rev-parse", "HEAD"]);

    const pulled = await pullFastForward(systemGit, local, undefined, {}, {
      kind: "ref",
      ref: "refs/remotes/upstream/main",
      label: "upstream/main",
      remotes: ["upstream"],
      branch: "release"
    });
    expect(pulled.ok).toBe(false);
    if (pulled.ok) return;
    expect(pulled.error.code).toBe("fork_sync_stale");
    expect(gitOut(local, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("refuses a push that names no resolved commit, without running git push", async () => {
    const calls: string[][] = [];
    const recording: GitExec = async (args) => {
      calls.push(args);
      return ok({ stdout: "origin\n", stderr: "", exitCode: 0 });
    };
    const pushed = await pushBranchWithLease(recording, "/repo", {
      remote: "origin",
      branch: "main",
      head: "main",
      expectedHead: "1".repeat(40)
    });
    expect(pushed.ok).toBe(false);
    if (pushed.ok) return;
    expect(pushed.error.code).toBe("invalid_push_plan");
    expect(calls.some((args) => args[0] === "push")).toBe(false);
  });
});

describe("fork source and fetch coverage, from remote URLs", () => {
  const endpoints = [
    {
      name: "origin",
      fetchUrl: "git@github.com:me/widget.git",
      pushUrl: "git@github.com:me/widget.git"
    },
    {
      name: "source",
      fetchUrl: "https://github.com/Acme/widget.git",
      pushUrl: "https://github.com/Acme/widget.git"
    },
    {
      name: "upstream",
      fetchUrl: "https://gitlab.example.com/mirror/widget.git",
      pushUrl: "https://gitlab.example.com/mirror/widget.git"
    }
  ];
  const parent = { hostname: "github.com", nameWithOwner: "acme/widget" };

  it("prefers the remote whose URL names the parent over one merely named upstream", () => {
    expect(forkSourceRemote(endpoints, "origin", parent)).toEqual({
      remote: "source",
      confirmed: true
    });
  });

  it("accepts an SSH host alias that still names the parent", () => {
    const aliased = [
      endpoints[0]!,
      {
        name: "theirs",
        fetchUrl: "git@github-work:acme/widget.git",
        pushUrl: "git@github-work:acme/widget.git"
      }
    ];
    expect(forkSourceRemote(aliased, "origin", parent)).toEqual({
      remote: "theirs",
      confirmed: true
    });
  });

  it("falls back to the `upstream` name, unconfirmed, when identity says nothing", () => {
    expect(forkSourceRemote(endpoints, "origin", null)).toEqual({
      remote: "upstream",
      confirmed: false
    });
  });

  it("never offers the branch's own remote as its fork source", () => {
    expect(forkSourceRemote(endpoints, "upstream", null)).toBeNull();
    expect(forkSourceRemote(endpoints, "source", parent)).toEqual({
      remote: "upstream",
      confirmed: false
    });
  });

  it("matches FETCH_HEAD's anonymized URLs back to remote names", () => {
    const fetchHead = [
      `${"a".repeat(40)}\t\tbranch 'main' of github.com:me/widget`,
      `${"b".repeat(40)}\tnot-for-merge\tbranch 'fix/x' of github.com:me/widget`,
      `${"c".repeat(40)}\tnot-for-merge\tbranch 'main' of https://github.com/Acme/widget`
    ].join("\n");
    const withToken = endpoints.map((endpoint) =>
      endpoint.name === "source"
        ? { ...endpoint, fetchUrl: "https://x-token:secret@github.com/Acme/widget.git/" }
        : endpoint
    );
    expect(fetchHeadRemotes(fetchHead, withToken)).toEqual(["origin", "source"]);
    expect(fetchHeadRemotes("", withToken)).toEqual([]);
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
  });

  it("counts only what a hard reset overwrites, not untracked files", async () => {
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
    // The dialog renders this as "N working-tree changes discarded", and
    // `reset --hard` leaves untracked.txt exactly where it is.
    expect(preview.value.dirty).toBe(1);
    expect(preview.value.snapshot.remoteRef).toBe("refs/remotes/origin/main");
  });
});
