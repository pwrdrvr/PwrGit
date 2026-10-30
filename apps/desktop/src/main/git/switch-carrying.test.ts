import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pwrgitLeftOnStashMessage } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import {
  parseSwitchOverwritePaths,
  switchBranch,
  switchBranchCarryingChanges,
  switchBranchLeavingChanges
} from "./git-service";
import { createSystemGit } from "./test-support/system-git";

/**
 * The carrying switch's whole contract is a promise about failure: either the
 * work lands on the destination, or the checkout is exactly where it started
 * with the work untouched. That cannot be asserted against a mocked git — the
 * interesting paths are what real `git stash pop` does to a real index when it
 * conflicts — so every case here runs the system git over a real repository.
 *
 * Through the shared helper, never a local copy: a hand-rolled one settles on
 * the child's `close`, and Git-for-Windows hands execution to another process
 * that keeps the inherited pipes open after git itself has exited — so a
 * millisecond call becomes a multi-second hang and the suite times out having
 * never learned what git did. #261 removed twenty-four copies of that defect;
 * this file must not be the twenty-fifth.
 */
const systemGit: GitExec = createSystemGit({
  env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null"
  }
});

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  });
}
function gitOut(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  }).trim();
}
const write = (dir: string, file: string, body: string): void =>
  writeFileSync(join(dir, file), body);
const read = (dir: string, file: string): string =>
  readFileSync(join(dir, file), "utf8");
const branchOf = (dir: string): string =>
  gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
const stashCount = (dir: string): number =>
  gitOut(dir, ["stash", "list"]).split("\n").filter((l) => l !== "").length;
const porcelain = (dir: string): string => gitOut(dir, ["status", "--porcelain"]);

/** `main` with `shared.txt`, plus a `feature` branch that rewrites that file —
 *  so a change to it on main cannot be carried over without conflicting. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-carry-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "T"]);
  write(dir, "shared.txt", "base\n");
  write(dir, "quiet.txt", "quiet\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  git(dir, ["switch", "-c", "feature"]);
  write(dir, "shared.txt", "feature rewrite\n");
  git(dir, ["commit", "-am", "diverge shared.txt"]);
  git(dir, ["switch", "main"]);
  return dir;
}

describe("switchBranchCarryingChanges", () => {
  it("carries work that does not touch what the destination changed", async () => {
    const dir = makeRepo();
    write(dir, "quiet.txt", "edited on main\n");
    write(dir, "brand-new.txt", "untracked\n");

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.carried).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    expect(read(dir, "quiet.txt")).toBe("edited on main\n");
    // Untracked work comes too — `--include-untracked` is the reason a switch
    // that would otherwise strand a new file does not.
    expect(read(dir, "brand-new.txt")).toBe("untracked\n");
    // And the destination's own version of the diverged file is intact.
    expect(read(dir, "shared.txt")).toBe("feature rewrite\n");
    expect(stashCount(dir)).toBe(0);
  });

  it("keeps the staged/unstaged split rather than flattening it", async () => {
    const dir = makeRepo();
    write(dir, "quiet.txt", "staged\n");
    git(dir, ["add", "quiet.txt"]);
    write(dir, "also.txt", "unstaged-and-untracked\n");

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    // "M " is staged-modified; a flattened reapply would read " M".
    expect(porcelain(dir)).toContain("M  quiet.txt");
    expect(porcelain(dir)).toContain("?? also.txt");
  });

  // The promise this function exists to make.
  it("puts everything back when the work cannot land on the destination", async () => {
    const dir = makeRepo();
    write(dir, "shared.txt", "edited on main\n");
    write(dir, "quiet.txt", "also edited\n");
    write(dir, "brand-new.txt", "untracked\n");
    const before = porcelain(dir);

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("carry_conflicts");
    expect(result.error.message).toContain("still on main");

    // As if nothing happened: same branch, same working tree, same stash stack.
    expect(branchOf(dir)).toBe("main");
    expect(read(dir, "shared.txt")).toBe("edited on main\n");
    expect(read(dir, "quiet.txt")).toBe("also edited\n");
    expect(read(dir, "brand-new.txt")).toBe("untracked\n");
    expect(porcelain(dir)).toBe(before);
    expect(stashCount(dir)).toBe(0);
    // No conflict markers anywhere — the whole point of rolling back rather
    // than leaving a half-applied stash on a branch nobody asked to be on.
    expect(read(dir, "shared.txt")).not.toContain("<<<<<<<");
  });

  // A conflicted reapply restores the stash's untracked files onto the
  // destination, and `reset --hard` does not remove untracked paths. Without the
  // bounded clean, switching back and restoring would fail on "already exists".
  it("clears the untracked files a failed reapply left behind", async () => {
    const dir = makeRepo();
    write(dir, "shared.txt", "edited on main\n");
    write(dir, "brand-new.txt", "untracked\n");

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(false);
    expect(branchOf(dir)).toBe("main");
    expect(read(dir, "brand-new.txt")).toBe("untracked\n");
    expect(stashCount(dir)).toBe(0);
  });

  // Rollback must clean only what the stash owned. A repository-wide
  // `clean -fd` would be a plausible-looking way to undo a failed reapply and
  // would delete whatever a build, an editor, or another tool wrote while the
  // switch was in flight — so the bystander has to appear AFTER the stash was
  // taken, which needs a hook rather than a race.
  it("leaves untracked files it never saved alone", async () => {
    const dir = makeRepo();
    write(dir, "shared.txt", "edited on main\n");
    const hooked: GitExec = async (args, cwd) => {
      const out = await systemGit(args, cwd);
      if (args[0] === "switch" && args[1] === "feature") {
        write(dir, "bystander.txt", "written by something else\n");
      }
      return out;
    };

    const result = await switchBranchCarryingChanges(hooked, dir, "feature");

    expect(result.ok).toBe(false);
    expect(branchOf(dir)).toBe("main");
    expect(existsSync(join(dir, "bystander.txt"))).toBe(true);
  });

  // A detached checkout has no branch to name, so the rollback restores a raw
  // commit. `git switch` refuses one without `--detach` ("a branch is expected,
  // got commit", exit 128), which turned every rollback from a detached HEAD
  // into a broken promise: the work stranded in a stash on a branch the reader
  // never chose.
  it("puts a detached checkout back where it was", async () => {
    const dir = makeRepo();
    const base = gitOut(dir, ["rev-parse", "HEAD"]);
    git(dir, ["switch", "--detach", base]);
    write(dir, "shared.txt", "edited while detached\n");
    write(dir, "brand-new.txt", "untracked\n");

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("carry_conflicts");
    // Still detached, still on the same commit, still holding the work.
    // `rev-parse --abbrev-ref` answers "HEAD" when detached; `symbolic-ref`
    // exits 1 there, which `execFileSync` raises as a thrown command failure
    // rather than a readable assertion.
    expect(gitOut(dir, ["rev-parse", "HEAD"])).toBe(base);
    expect(branchOf(dir)).toBe("HEAD");
    expect(read(dir, "shared.txt")).toBe("edited while detached\n");
    expect(read(dir, "brand-new.txt")).toBe("untracked\n");
    expect(stashCount(dir)).toBe(0);
  });

  it("carries a detached checkout's work onto a branch when it fits", async () => {
    const dir = makeRepo();
    git(dir, ["switch", "--detach", gitOut(dir, ["rev-parse", "HEAD"])]);
    write(dir, "quiet.txt", "edited while detached\n");

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    expect(read(dir, "quiet.txt")).toBe("edited while detached\n");
    expect(stashCount(dir)).toBe(0);
  });

  it("switches with nothing to carry when the tree went clean", async () => {
    const dir = makeRepo();

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `carried: false` is what stops the UI reporting changes it did not move.
    expect(result.value.carried).toBe(false);
    expect(branchOf(dir)).toBe("feature");
    expect(stashCount(dir)).toBe(0);
  });

  // A refused switch leaves the work in the stash and nothing else moved, so
  // the repair is the reapply — and the caller still needs git's own reason,
  // because `checked_out_elsewhere` is a navigation upstream, not a failure.
  it("restores the work and reports the original refusal when the switch fails", async () => {
    const dir = makeRepo();
    const linked = `${dir}-linked`;
    git(dir, ["worktree", "add", linked, "feature"]);
    write(dir, "quiet.txt", "edited on main\n");

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("checked_out_elsewhere");
    expect(branchOf(dir)).toBe("main");
    expect(read(dir, "quiet.txt")).toBe("edited on main\n");
    expect(stashCount(dir)).toBe(0);
  });

  // Stash positions shift. Resolving the entry by commit identity is what keeps
  // this from reapplying somebody else's work over the user's.
  it("restores its own entry, not whatever reached the top of the stack", async () => {
    const dir = makeRepo();
    write(dir, "quiet.txt", "someone else's work\n");
    git(dir, ["stash", "push", "-m", "unrelated"]);
    write(dir, "quiet.txt", "edited on main\n");

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    expect(read(dir, "quiet.txt")).toBe("edited on main\n");
    // The pre-existing entry is untouched and still says what it said.
    expect(stashCount(dir)).toBe(1);
    expect(gitOut(dir, ["stash", "list"])).toContain("unrelated");
  });
});

/** `makeRepo`, plus a file `feature` added that `main` does not track — so an
 *  untracked file of that name on `main` is one a switch would overwrite. */
function makeRepoWithFeatureOnlyFile(): string {
  const dir = makeRepo();
  git(dir, ["switch", "feature"]);
  write(dir, "only-on-feature.txt", "feature's own\n");
  git(dir, ["add", "only-on-feature.txt"]);
  git(dir, ["commit", "-m", "add only-on-feature.txt"]);
  git(dir, ["switch", "main"]);
  return dir;
}

/**
 * "Bring my changes" is a plain `git switch` first. Git carries modified and
 * untracked files that the destination does not touch, and refuses, atomically,
 * when one would be overwritten — so the common case needs no stash at all,
 * and the refusal has to name the files so the reader can be asked about them.
 */
describe("switchBranch (bring my changes)", () => {
  it("brings untracked and non-conflicting modified files without a stash", async () => {
    const dir = makeRepo();
    write(dir, "quiet.txt", "edited on main\n");
    write(dir, "brand-new.txt", "untracked\n");

    const result = await switchBranch(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    expect(read(dir, "quiet.txt")).toBe("edited on main\n");
    expect(read(dir, "brand-new.txt")).toBe("untracked\n");
    expect(read(dir, "shared.txt")).toBe("feature rewrite\n");
    // The point of trying the plain switch first: nothing was stashed.
    expect(gitOut(dir, ["stash", "list"])).toBe("");
  });

  it("refuses with the files Git named, tracked and untracked, and moves nothing", async () => {
    const dir = makeRepoWithFeatureOnlyFile();
    write(dir, "shared.txt", "edited on main\n");
    write(dir, "only-on-feature.txt", "mine, untracked\n");
    write(dir, "quiet.txt", "also edited\n");
    const before = porcelain(dir);

    const result = await switchBranch(systemGit, dir, "feature");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("switch_would_overwrite");
    expect([...(result.error.paths ?? [])].sort()).toEqual([
      "only-on-feature.txt",
      "shared.txt"
    ]);
    expect(branchOf(dir)).toBe("main");
    expect(read(dir, "shared.txt")).toBe("edited on main\n");
    expect(read(dir, "only-on-feature.txt")).toBe("mine, untracked\n");
    expect(read(dir, "quiet.txt")).toBe("also edited\n");
    expect(porcelain(dir)).toBe(before);
    expect(stashCount(dir)).toBe(0);
  });

  // The fallback the reader is offered after that refusal. A plain switch
  // refuses whenever a modified file differs between the branches, even when
  // the edits would merge; the carrying switch merges them.
  it("still merges the work in through the carrying switch after a refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrgit-carry-"));
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "t@t.com"]);
    git(dir, ["config", "user.name", "T"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    write(dir, "lines.txt", "one\ntwo\nthree\nfour\nfive\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["switch", "-c", "feature"]);
    write(dir, "lines.txt", "ONE\ntwo\nthree\nfour\nfive\n");
    git(dir, ["commit", "-am", "feature edits the first line"]);
    git(dir, ["switch", "main"]);
    write(dir, "lines.txt", "one\ntwo\nthree\nfour\nFIVE\n");

    const refused = await switchBranch(systemGit, dir, "feature");
    expect(!refused.ok && refused.error.code).toBe("switch_would_overwrite");
    expect(!refused.ok && refused.error.paths).toEqual(["lines.txt"]);
    expect(branchOf(dir)).toBe("main");

    const merged = await switchBranchCarryingChanges(systemGit, dir, "feature");
    expect(merged.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    expect(read(dir, "lines.txt")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(stashCount(dir)).toBe(0);
  });
});

describe("parseSwitchOverwritePaths", () => {
  it("reads every list Git printed, and nothing else", () => {
    const stderr = [
      "error: Your local changes to the following files would be overwritten by checkout:",
      "\tshared.txt",
      "\tdír/ünï name.txt",
      "Please commit your changes or stash them before you switch branches.",
      "error: The following untracked working tree files would be overwritten by checkout:",
      "\tonly-on-feature.txt",
      "Please move or remove them before you switch branches.",
      "error: The following untracked working tree files would be removed by checkout:",
      "\tgone/file.txt",
      "Please move or remove them before you switch branches.",
      "Aborting"
    ].join("\r\n");
    expect(parseSwitchOverwritePaths(stderr)).toEqual([
      "shared.txt",
      "dír/ünï name.txt",
      "only-on-feature.txt",
      "gone/file.txt"
    ]);
  });

  it("finds nothing in an unrelated refusal", () => {
    expect(
      parseSwitchOverwritePaths("fatal: invalid reference: nope\n")
    ).toEqual([]);
  });
});

/**
 * "Leave my changes on <branch>": stash them with the branch they were made on,
 * then switch. Coming back looks for the stash's exact message.
 */
describe("switchBranchLeavingChanges", () => {
  it("stashes the work under the branch it was made on, then switches clean", async () => {
    const dir = makeRepo();
    write(dir, "shared.txt", "edited on main\n");
    write(dir, "brand-new.txt", "untracked\n");

    const result = await switchBranchLeavingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.left).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    // Clean on the destination: its own file, and none of the left work.
    expect(porcelain(dir)).toBe("");
    expect(read(dir, "shared.txt")).toBe("feature rewrite\n");
    expect(existsSync(join(dir, "brand-new.txt"))).toBe(false);
    expect(gitOut(dir, ["stash", "list", "--format=%gs"])).toBe(
      `On main: ${pwrgitLeftOnStashMessage("main")}`
    );
    // And the stash really holds it, untracked file included.
    git(dir, ["switch", "main"]);
    git(dir, ["stash", "apply", gitOut(dir, ["rev-parse", "refs/stash"])]);
    expect(read(dir, "shared.txt")).toBe("edited on main\n");
    expect(read(dir, "brand-new.txt")).toBe("untracked\n");
  });

  it("puts the work back when the switch fails after the stash", async () => {
    const dir = makeRepo();
    const linked = `${dir}-linked`;
    git(dir, ["worktree", "add", linked, "feature"]);
    write(dir, "shared.txt", "edited on main\n");
    write(dir, "brand-new.txt", "untracked\n");
    const before = porcelain(dir);

    const result = await switchBranchLeavingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Git's own refusal, so the caller can still go to the worktree holding it.
    expect(result.error.code).toBe("checked_out_elsewhere");
    expect(branchOf(dir)).toBe("main");
    expect(read(dir, "shared.txt")).toBe("edited on main\n");
    expect(read(dir, "brand-new.txt")).toBe("untracked\n");
    expect(porcelain(dir)).toBe(before);
    expect(stashCount(dir)).toBe(0);
  });

  it("switches without a stash when the tree went clean", async () => {
    const dir = makeRepo();

    const result = await switchBranchLeavingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.left).toBe(false);
    expect(branchOf(dir)).toBe("feature");
    expect(stashCount(dir)).toBe(0);
  });

  it("names a detached checkout's stash by its commit", async () => {
    const dir = makeRepo();
    git(dir, ["switch", "--detach", "HEAD"]);
    const short = gitOut(dir, ["rev-parse", "HEAD"]).trim().slice(0, 12);
    write(dir, "quiet.txt", "edited while detached\n");

    const result = await switchBranchLeavingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    expect(gitOut(dir, ["stash", "list", "--format=%gs"])).toContain(
      pwrgitLeftOnStashMessage(short)
    );
  });
});

/**
 * Agents keep linked worktrees INSIDE the checkout (`.claude/worktrees/x`).
 * To the outer checkout that is an untracked directory holding a `.git` file,
 * and `git stash -u` answers it with "Ignoring path" — it must not be swept
 * into a stash, cleaned away, or overwritten by any of the three answers.
 */
describe("a linked worktree nested inside the checkout", () => {
  function makeNested(): { dir: string; inner: string } {
    const dir = makeRepo();
    const inner = join(dir, ".claude", "worktrees", "x");
    git(dir, ["worktree", "add", "-b", "agent-x", inner, "main"]);
    write(inner, "agent-work.txt", "the agent's uncommitted work\n");
    write(inner, "quiet.txt", "the agent's edit\n");
    return { dir, inner };
  }
  const survives = (inner: string): void => {
    expect(read(inner, "agent-work.txt")).toBe("the agent's uncommitted work\n");
    expect(read(inner, "quiet.txt")).toBe("the agent's edit\n");
    expect(branchOf(inner)).toBe("agent-x");
  };

  it("survives a plain bring", async () => {
    const { dir, inner } = makeNested();
    write(dir, "quiet.txt", "edited on main\n");
    expect((await switchBranch(systemGit, dir, "feature")).ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    survives(inner);
  });

  it("survives a leave", async () => {
    const { dir, inner } = makeNested();
    write(dir, "shared.txt", "edited on main\n");
    write(dir, "brand-new.txt", "untracked\n");
    const result = await switchBranchLeavingChanges(systemGit, dir, "feature");
    expect(result.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    survives(inner);
    // The stash holds the outer checkout's work only.
    const stash = gitOut(dir, ["rev-parse", "refs/stash"]);
    expect(
      gitOut(dir, ["show", "--name-only", "--format=", `${stash}^3`])
    ).not.toContain(".claude");
  });

  it("survives a merge that lands", async () => {
    const { dir, inner } = makeNested();
    write(dir, "quiet.txt", "edited on main\n");
    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");
    expect(result.ok).toBe(true);
    expect(branchOf(dir)).toBe("feature");
    survives(inner);
  });

  it("survives a merge that rolls back", async () => {
    const { dir, inner } = makeNested();
    write(dir, "shared.txt", "edited on main\n");
    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");
    expect(!result.ok && result.error.code).toBe("carry_conflicts");
    expect(branchOf(dir)).toBe("main");
    expect(read(dir, "shared.txt")).toBe("edited on main\n");
    survives(inner);
  });
});
