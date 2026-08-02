import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type RemoteDivergence, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  fetchRemote,
  inspectRemoteDivergence,
  pullFastForward,
  pushRemote,
  rebaseOntoUpstream,
  resetToUpstream
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
