import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ok,
  type BranchCleanupOptions,
  type StaleBranch
} from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import {
  collectGarbage,
  deleteStaleBranches,
  garbageCollectionArgs,
  maintenanceCommonDirectory,
  objectStorageBytes,
  restoreStaleBranch,
  reviewStaleBranches,
  type BranchPrEvidence,
  type StaleBranchReview
} from "./repository-maintenance";

const systemGit = createSystemGit();
const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
/** A commit whose committer date is `date`, so the age guard has an old tip
 *  to look at without the test waiting a week. */
function commitAt(cwd: string, date: string, message: string): void {
  execFileSync("git", ["-C", cwd, "commit", "--allow-empty", "-m", message], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }
  });
}
function fixture(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-maintenance-")));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Maintenance Test");
  git(repo, "config", "user.email", "maintenance@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "tracked.txt"), "keep me\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Initial commit");
  git(root, "init", "--bare", "remote.git");
  git(repo, "remote", "add", "origin", join(root, "remote.git"));
  git(repo, "push", "-u", "origin", "main");
  return { root, repo };
}
function gone(repo: string, name: string): void {
  git(repo, "branch", name);
  git(repo, "push", "-u", "origin", name);
  git(repo, "push", "origin", "--delete", name);
}
/** No age guard unless a test asks: fixture commits are all minutes old. */
const NO_GUARD: BranchCleanupOptions = { prProof: true, keepDays: null };
async function reviewed(
  repo: string,
  input: {
    options?: BranchCleanupOptions;
    prs?: Map<string, BranchPrEvidence>;
    now?: number;
  } = {}
): Promise<StaleBranchReview> {
  const result = await reviewStaleBranches(systemGit, repo, "repo", {
    options: input.options ?? NO_GUARD,
    prs: input.prs ?? new Map(),
    now: input.now ?? Date.now()
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function review(repo: string): Promise<StaleBranch[]> {
  return (await reviewed(repo)).candidates;
}
/** Delete one branch through the batch path, answering its own result. */
async function deleteOne(
  repo: string,
  candidate: StaleBranch,
  fresh: StaleBranchReview
) {
  const results = await deleteStaleBranches(systemGit, repo, [candidate], fresh);
  return results.ok ? results.value.get(candidate.branch)! : results;
}
async function remove(repo: string, candidate: StaleBranch) {
  return deleteOne(repo, candidate, await reviewed(repo));
}
/** A gone branch with one commit of its own, squash-merged into main — the
 *  shape GitHub's squash button leaves behind. Returns the branch's tip. */
function squashMerged(repo: string, name: string): string {
  gone(repo, name);
  git(repo, "checkout", name);
  writeFileSync(join(repo, `${name}.txt`), "feature\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Feature");
  const tip = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  git(repo, "merge", "--squash", name);
  git(repo, "commit", "-m", "Squashed feature");
  return tip;
}
const merged = (headOid?: string): BranchPrEvidence => ({
  number: 412,
  url: "https://example.test/pull/412",
  state: "merged",
  mergedAt: Date.parse("2026-09-01T00:00:00Z"),
  ...(headOid === undefined ? {} : { headOid })
});
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("repository maintenance with real Git", () => {
  it("reports an empty review when the checkout has no local commits", async () => {
    const { repo } = fixture();
    git(repo, "update-ref", "-d", "refs/heads/main");
    expect(await review(repo)).toEqual([]);
  });
  it.each(["standard", "keep-largest", "aggressive"] as const)(
    "runs %s collection without changing refs or dirty files",
    async (mode) => {
      const { repo } = fixture();
      const refs = git(repo, "show-ref");
      writeFileSync(join(repo, "tracked.txt"), "local edits\n");
      writeFileSync(join(repo, "untracked.txt"), "also keep me\n");
      const status = git(repo, "status", "--porcelain");
      // Git on Windows counts loose-object file lengths, then truncates to
      // whole KiB. This tiny fixture can legitimately report zero before GC.
      expect(await objectStorageBytes(systemGit, repo)).toBeGreaterThanOrEqual(
        0
      );
      expect(await collectGarbage(systemGit, repo, mode)).toEqual({
        ok: true,
        value: undefined
      });
      expect(git(repo, "show-ref")).toBe(refs);
      expect(git(repo, "status", "--porcelain")).toBe(status);
      expect(await objectStorageBytes(systemGit, repo)).toBeGreaterThan(0);
      expect(garbageCollectionArgs(mode)).not.toContain("--prune=now");
    }
  );

  it("keeps missing worktree registrations even when user configuration expires them now", async () => {
    const { root, repo } = fixture();
    const worktree = join(root, "missing");
    git(repo, "worktree", "add", "-b", "held", worktree);
    rmSync(worktree, { recursive: true, force: true });
    git(repo, "config", "gc.worktreePruneExpire", "now");
    expect((await collectGarbage(systemGit, repo, "standard")).ok).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(
      "refs/heads/held"
    );
  });

  it("resolves linked worktrees to the same object store and refuses missing checkout metadata", async () => {
    const { root, repo } = fixture();
    const worktree = join(root, "linked");
    git(repo, "worktree", "add", "-b", "held", worktree);
    expect(await maintenanceCommonDirectory(systemGit, worktree)).toEqual(
      await maintenanceCommonDirectory(systemGit, repo)
    );
    const nested = join(repo, "nested");
    mkdirSync(nested);
    expect((await maintenanceCommonDirectory(systemGit, nested)).ok).toBe(
      false
    );
  });

  it("offers only merged, unoccupied local branches with a gone upstream", async () => {
    const { root, repo } = fixture();
    gone(repo, "finished");
    gone(repo, "develop");
    gone(repo, "held");
    git(repo, "worktree", "add", join(root, "held"), "held");
    git(repo, "branch", "no-upstream");
    git(repo, "branch", "live-upstream");
    git(repo, "push", "-u", "origin", "live-upstream");
    gone(repo, "unique");
    git(repo, "checkout", "unique");
    writeFileSync(join(repo, "unique.txt"), "unmerged\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Unique work");
    git(repo, "checkout", "main");
    const result = await reviewed(repo);
    expect(result.candidates.map((branch) => branch.branch)).toEqual([
      "finished"
    ]);
    expect(result.candidates[0]).toMatchObject({ evidence: "ancestry" });
    // Every gone branch is accounted for: protected names are not listed,
    // the rest say why they stayed.
    expect(
      result.kept.map(({ branch, reason }) => [branch, reason])
    ).toEqual(
      expect.arrayContaining([
        ["held", "worktree"],
        ["unique", "no_proof"]
      ])
    );
    expect(result.kept.map((branch) => branch.branch)).not.toContain(
      "develop"
    );
  });

  it("deletes only the reviewed local branch and its tracking configuration", async () => {
    const { repo } = fixture();
    gone(repo, "finished");
    const candidate = (await review(repo))[0]!;
    expect((await remove(repo, candidate)).ok).toBe(true);
    expect(git(repo, "branch", "--list", "finished")).toBe("");
    expect(git(repo, "ls-remote", "--heads", "origin")).toContain(
      "refs/heads/main"
    );
    expect(git(repo, "config", "--list")).not.toContain("branch.finished.");
  });

  it.each([
    ["origin", "production"],
    ["upstream", "release/production"]
  ])(
    "protects %s's default branch when fetch leaves remote HEAD dangling",
    async (remote, branch) => {
      const { root, repo } = fixture();
      if (remote !== "origin") {
        git(repo, "remote", "add", remote, join(root, "remote.git"));
      }
      git(repo, "branch", branch);
      git(repo, "push", "-u", remote, branch);
      const remoteHead = `refs/remotes/${remote}/HEAD`;
      const target = `refs/remotes/${remote}/${branch}`;
      git(repo, "symbolic-ref", remoteHead, target);
      git(join(root, "remote.git"), "update-ref", "-d", `refs/heads/${branch}`);
      // Git 2.48–2.51 treat a dangling remote HEAD as missing under the
      // default followRemoteHEAD=create and re-point it at the remote's HEAD
      // (fixed in 2.52; older Git never touches it). Pin the one behavior
      // every version shares so the fetch leaves the symref dangling.
      git(repo, "config", `remote.${remote}.followRemoteHEAD`, "never");
      git(repo, "fetch", "--prune", remote);
      expect(git(repo, "symbolic-ref", remoteHead)).toBe(target);
      const refs = git(repo, "for-each-ref", "--format=%(refname)").split("\n");
      expect(refs).not.toContain(remoteHead);
      expect(refs).not.toContain(target);
      gone(repo, "finished");

      expect((await review(repo)).map((candidate) => candidate.branch)).toEqual(
        ["finished"]
      );
      expect(git(repo, "branch", "--list", branch)).toContain(branch);
    }
  );

  it("rechecks dangling remote HEAD protection before deleting a reviewed branch", async () => {
    const { repo } = fixture();
    gone(repo, "production");
    const candidate = (await review(repo))[0]!;
    expect(candidate.branch).toBe("production");
    git(
      repo,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/production"
    );

    expect(await remove(repo, candidate)).toMatchObject({
      ok: false,
      error: { code: "stale_branch_review" }
    });
    expect(git(repo, "rev-parse", "refs/heads/production")).toBe(
      candidate.expectedHead
    );
  });

  it("refuses review when remote HEAD cannot be inspected", async () => {
    const { repo } = fixture();
    gone(repo, "production");
    const unreadableHead: GitExec = (args, cwd, options) =>
      args[0] === "symbolic-ref"
        ? Promise.resolve(
            ok({
              exitCode: 128,
              stdout: "",
              stderr: "fatal: cannot read reference"
            })
          )
        : systemGit(args, cwd, options);
    expect(
      (
        await reviewStaleBranches(unreadableHead, repo, "repo", {
          options: NO_GUARD,
          prs: new Map(),
          now: Date.now()
        })
      ).ok
    ).toBe(false);
  });

  it.each(["moved", "upstream-restored", "checked-out"])(
    "retains a branch that became %s after review",
    async (change) => {
      const { root, repo } = fixture();
      gone(repo, "finished");
      const candidate = (await review(repo))[0]!;
      if (change === "moved") {
        git(repo, "commit", "--allow-empty", "-m", "Next commit");
        git(repo, "branch", "-f", "finished", "HEAD");
      } else if (change === "upstream-restored") {
        git(repo, "update-ref", "refs/remotes/origin/finished", "HEAD");
      } else git(repo, "worktree", "add", join(root, "held"), "finished");
      expect((await remove(repo, candidate)).ok).toBe(false);
      expect(git(repo, "branch", "--list", "finished")).toContain("finished");
    }
  );

  it("retains squash-merged tips that no merged pull request proves", async () => {
    const { repo } = fixture();
    squashMerged(repo, "squashed");
    const result = await reviewed(repo);
    expect(result.candidates).toEqual([]);
    expect(result.kept).toEqual([
      expect.objectContaining({ branch: "squashed", reason: "no_proof" })
    ]);
    expect(existsSync(join(repo, "squashed.txt"))).toBe(true);
  });

  it("offers a squash-merged branch whose tip is its merged PR's head, and deletes it", async () => {
    const { repo } = fixture();
    const tip = squashMerged(repo, "squashed");
    const prs = new Map([["squashed", merged(tip)]]);
    const result = await reviewed(repo, { prs });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        branch: "squashed",
        evidence: "pr",
        expectedHead: tip,
        pr: expect.objectContaining({ number: 412 })
      })
    ]);
    // `git branch -d` refuses this branch — its commits are not in HEAD —
    // so the PR-proven path must be the compare-and-swap, not the merge check.
    expect(
      await deleteOne(repo, result.candidates[0]!, result)
    ).toEqual({ ok: true, value: undefined });
    expect(git(repo, "branch", "--list", "squashed")).toBe("");
    expect(git(repo, "config", "--list")).not.toContain("branch.squashed.");
  });

  it("proves a tip that is an ancestor of the PR's head", async () => {
    const { repo } = fixture();
    const tip = squashMerged(repo, "squashed");
    // Someone pushed one more commit to the PR after this checkout's copy.
    git(repo, "checkout", "--detach", tip);
    git(repo, "commit", "--allow-empty", "-m", "Reviewer fix");
    const prHead = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "main");
    const result = await reviewed(repo, {
      prs: new Map([["squashed", merged(prHead)]])
    });
    expect(result.candidates.map((branch) => branch.evidence)).toEqual(["pr"]);
  });

  it("keeps a merged-PR branch with local commits the PR never had", async () => {
    const { repo } = fixture();
    const tip = squashMerged(repo, "squashed");
    git(repo, "checkout", "squashed");
    git(repo, "commit", "--allow-empty", "-m", "After the merge");
    git(repo, "commit", "--allow-empty", "-m", "And another");
    git(repo, "checkout", "main");
    const result = await reviewed(repo, {
      prs: new Map([["squashed", merged(tip)]])
    });
    expect(result.candidates).toEqual([]);
    expect(result.kept).toEqual([
      expect.objectContaining({
        reason: "unmerged_commits",
        detail: "2 local commits not in #412"
      })
    ]);
  });

  it.each([
    ["no head commit is known", merged(), "no_proof"],
    ["the PR closed unmerged", { ...merged(), state: "closed" as const }, "pr_closed"],
    ["the PR is open", { ...merged(), state: "open" as const }, "pr_open"]
  ])("keeps a squash-merged branch when %s", async (_name, pr, reason) => {
    const { repo } = fixture();
    squashMerged(repo, "squashed");
    const result = await reviewed(repo, { prs: new Map([["squashed", pr]]) });
    expect(result.candidates).toEqual([]);
    expect(result.kept[0]).toMatchObject({ reason });
  });

  it("keeps PR-proven branches when PR proof is switched off", async () => {
    const { repo } = fixture();
    const tip = squashMerged(repo, "squashed");
    const result = await reviewed(repo, {
      options: { prProof: false, keepDays: null },
      prs: new Map([["squashed", merged(tip)]])
    });
    expect(result.candidates).toEqual([]);
    expect(result.kept[0]).toMatchObject({ reason: "pr_proof_off" });
  });

  it("holds proven branches touched inside the age guard, and only those", async () => {
    const { repo } = fixture();
    gone(repo, "recent");
    git(repo, "checkout", "-b", "old");
    commitAt(repo, "2020-01-01T00:00:00Z", "Old work");
    git(repo, "checkout", "main");
    git(repo, "merge", "--ff-only", "old");
    git(repo, "push", "-u", "origin", "old");
    git(repo, "push", "origin", "--delete", "old");
    const week = { prProof: true, keepDays: 7 } as const;
    // `old`'s tip is from 2020 but it was checked out moments ago, which the
    // HEAD reflog remembers and the commit date does not.
    let result = await reviewed(repo, { options: week });
    expect(result.kept.map(({ branch, reason }) => [branch, reason])).toEqual(
      expect.arrayContaining([
        ["recent", "recent"],
        ["old", "recent"]
      ])
    );
    const later = Date.now() + 30 * 24 * 60 * 60 * 1000;
    result = await reviewed(repo, { options: week, now: later });
    expect(result.candidates.map((branch) => branch.branch).sort()).toEqual([
      "old",
      "recent"
    ]);
    expect(result.candidates.every((branch) => branch.touchedAt! > Date.parse("2021-01-01"))).toBe(true);
  });

  it("restores a deleted branch at its tip, and refuses a taken name", async () => {
    const { repo } = fixture();
    const tip = squashMerged(repo, "squashed");
    const result = await reviewed(repo, {
      prs: new Map([["squashed", merged(tip)]])
    });
    await deleteOne(repo, result.candidates[0]!, result);
    expect(await restoreStaleBranch(systemGit, repo, "squashed", tip)).toEqual({
      ok: true,
      value: undefined
    });
    expect(git(repo, "rev-parse", "refs/heads/squashed")).toBe(tip);
    // The upstream was the thing that was gone; do not resurrect it.
    expect(git(repo, "config", "--list")).not.toContain("branch.squashed.");
    expect(
      await restoreStaleBranch(systemGit, repo, "squashed", tip)
    ).toMatchObject({ ok: false, error: { code: "branch_exists" } });
  });

  // This 130-branch fixture also removes each branch's Git config. Windows CI
  // has completed it in 14s and once hit the suite's 20s limit mid-cleanup.
  it("deletes a batch larger than one transaction; a moved or checked-out branch fails alone", async () => {
    const { root, repo } = fixture();
    git(repo, "commit", "--allow-empty", "-m", "Second");
    const head = git(repo, "rev-parse", "HEAD");
    const names = Array.from(
      { length: 130 },
      (_, index) => `done/${String(index).padStart(3, "0")}`
    );
    // Gone branches in bulk: local refs whose configured upstream was never
    // fetched — what a pruning fetch leaves once the remote branch is deleted.
    execFileSync("git", ["-C", repo, "update-ref", "--stdin"], {
      input: names.map((name) => `create refs/heads/${name} ${head}\n`).join("")
    });
    appendFileSync(
      join(repo, ".git", "config"),
      names
        .map(
          (name) =>
            `[branch "${name}"]\n\tremote = origin\n\tmerge = refs/heads/${name}\n`
        )
        .join("")
    );
    const fresh = await reviewed(repo);
    expect(fresh.candidates).toHaveLength(130);
    // After the review: one branch moves (still in HEAD, so only the
    // compare-and-swap can catch it) and one is checked out.
    git(repo, "update-ref", "refs/heads/done/005", `${head}~1`);
    git(repo, "worktree", "add", join(root, "held"), "done/120");
    // Cancelled before it starts: nothing is attempted, so nothing answers.
    const cancelled = await deleteStaleBranches(
      systemGit,
      repo,
      fresh.candidates,
      fresh,
      { signal: AbortSignal.abort() }
    );
    expect(cancelled.ok && cancelled.value.size).toBe(0);
    const progress: Array<[number, number]> = [];
    const results = await deleteStaleBranches(
      systemGit,
      repo,
      fresh.candidates,
      fresh,
      {
        onProgress: (done, deleted) => {
          // Between the two transactions a worktree takes a branch the
          // second one would delete; update-ref alone would not refuse it.
          if (progress.length === 0)
            git(repo, "worktree", "add", join(root, "late"), "done/110");
          progress.push([done, deleted]);
        }
      }
    );
    if (!results.ok) throw new Error(results.error.message);
    expect(results.value.get("done/005")).toMatchObject({
      ok: false,
      error: { code: "stale_branch" }
    });
    expect(results.value.get("done/120")).toMatchObject({
      ok: false,
      error: { code: "branch_checked_out" }
    });
    expect(results.value.get("done/110")).toMatchObject({
      ok: false,
      error: { code: "branch_checked_out" }
    });
    expect(
      [...results.value.values()].filter((result) => result.ok)
    ).toHaveLength(127);
    expect(progress.at(-1)).toEqual([130, 127]);
    expect(
      git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/done/")
    ).toBe("done/005\ndone/110\ndone/120");
    expect(
      git(repo, "config", "--get-regexp", "^branch\\.done/.*\\.remote$")
    ).toBe(
      "branch.done/005.remote origin\nbranch.done/110.remote origin\nbranch.done/120.remote origin"
    );
  }, 60_000);

  it("refuses to delete a branch reviewed on different evidence", async () => {
    const { repo } = fixture();
    const tip = squashMerged(repo, "squashed");
    const prs = new Map([["squashed", merged(tip)]]);
    const result = await reviewed(repo, { prs });
    // PR proof switched off between review and delete: the fresh review no
    // longer offers it, so nothing is force-deleted.
    const fresh = await reviewed(repo, {
      prs,
      options: { prProof: false, keepDays: null }
    });
    expect(
      await deleteOne(repo, result.candidates[0]!, fresh)
    ).toMatchObject({ ok: false, error: { code: "stale_branch_review" } });
    expect(git(repo, "rev-parse", "refs/heads/squashed")).toBe(tip);
  });
});
