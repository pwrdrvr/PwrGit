import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { switchBranchCarryingChanges } from "./git-service";

/**
 * The carrying switch's whole contract is a promise about failure: either the
 * work lands on the destination, or the checkout is exactly where it started
 * with the work untouched. That cannot be asserted against a mocked git — the
 * interesting paths are what real `git stash pop` does to a real index when it
 * conflicts — so every case here runs the system git over a real repository.
 */
const systemGit: GitExec = (args, cwd) =>
  new Promise<Result<GitOutput>>((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => resolve(ok({ stdout, stderr, exitCode: code ?? 0 })));
    proc.on("error", (e) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: e.message }))
    );
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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

  it("switches with nothing to carry when the tree went clean", async () => {
    const dir = makeRepo();

    const result = await switchBranchCarryingChanges(systemGit, dir, "feature");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `carried: false` is what stops the UI reporting changes it did not move.
    expect(result.value.carried).toBe(false);
    expect(branchOf(dir)).toBe("feature");
    expect(stashCount(dir)).toBe(0);
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);
});
