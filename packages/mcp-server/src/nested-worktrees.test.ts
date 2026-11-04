import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nestedWorktreeExcludes, nestedWorktreePathspec } from "./nested-worktrees.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository with an agent worktree inside it and a sibling outside it. */
function fixture(): { primary: string; nested: string; sibling: string } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-nested-wt-"));
  roots.push(root);
  const primary = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", primary]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Test"]);
  git(primary, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(primary, "a.txt"), "a\n");
  git(primary, ["add", "a.txt"]);
  git(primary, ["commit", "-q", "-m", "init"]);
  const nested = join(primary, ".claude", "worktrees", "agent-1");
  git(primary, ["worktree", "add", "-q", "-b", "agent", nested]);
  writeFileSync(join(nested, "agent-work.txt"), "wip\n");
  const sibling = join(root, "sibling");
  git(primary, ["worktree", "add", "-q", "-b", "sibling", sibling]);
  return { primary, nested, sibling };
}

function status(cwd: string, extra: string[]): string[] {
  return git(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", ...extra])
    .split("\n")
    .filter((line) => line !== "");
}

describe("nestedWorktreeExcludes", () => {
  it("excludes a linked worktree inside the checkout, and nothing else", async () => {
    const { primary } = fixture();
    expect(await nestedWorktreeExcludes(primary)).toEqual([
      ":(exclude,top,literal).claude/worktrees/agent-1"
    ]);
    // Git alone counts the agent's checkout as an uncommitted change.
    expect(status(primary, []).filter((l) => !l.startsWith("#"))).toEqual(["? .claude/"]);
    const lines = status(primary, await nestedWorktreePathspec(primary));
    expect(lines.filter((l) => !l.startsWith("#"))).toEqual([]);
    // The branch headers the sidebar reads are untouched.
    expect(lines).toContain("# branch.head main");
  });

  it("still reports a real file beside the nested worktree", async () => {
    const { primary } = fixture();
    writeFileSync(join(primary, ".claude", "notes.md"), "mine\n");
    const lines = status(primary, await nestedWorktreePathspec(primary));
    expect(lines.filter((l) => !l.startsWith("#"))).toEqual(["? .claude/"]);
  });

  it("finds nested worktrees from a linked worktree's own root", async () => {
    const { sibling } = fixture();
    const inner = join(sibling, "agents", "inner");
    git(sibling, ["worktree", "add", "-q", "-b", "inner", inner]);
    expect(await nestedWorktreeExcludes(sibling)).toEqual([
      ":(exclude,top,literal)agents/inner"
    ]);
  });

  it("does not exclude an independent repository nested in the tree", async () => {
    const { primary } = fixture();
    const vendored = join(primary, "vendor", "lib");
    mkdirSync(vendored, { recursive: true });
    execFileSync("git", ["init", "-q", vendored]);
    const excludes = await nestedWorktreeExcludes(primary);
    expect(excludes).not.toContain(":(exclude,top,literal)vendor/lib");
  });

  it("keeps asking about a worktree whose folder did not exist yet", async () => {
    // `git worktree add` registers the admin entry before it writes the
    // checkout; a read in between must not cache the worktree away.
    const { primary, nested } = fixture();
    const aside = `${nested}-aside`;
    renameSync(nested, aside);
    expect(await nestedWorktreeExcludes(primary)).toEqual([]);
    renameSync(aside, nested);
    expect(await nestedWorktreeExcludes(primary)).toEqual([
      ":(exclude,top,literal).claude/worktrees/agent-1"
    ]);
  });

  it("treats a folder named like ..scratch as inside the checkout", async () => {
    const { primary } = fixture();
    git(primary, ["worktree", "add", "-q", "-b", "dots", join(primary, "..scratch", "wt")]);
    expect(await nestedWorktreeExcludes(primary)).toContain(
      ":(exclude,top,literal)..scratch/wt"
    );
  });

  it("notices a worktree added after the first read", async () => {
    const { primary } = fixture();
    await nestedWorktreeExcludes(primary);
    git(primary, ["worktree", "add", "-q", "-b", "later", join(primary, "later-wt")]);
    expect(await nestedWorktreeExcludes(primary)).toContain(
      ":(exclude,top,literal)later-wt"
    );
  });

  it("answers none for a folder that is not a checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-nested-none-"));
    roots.push(root);
    expect(await nestedWorktreeExcludes(root)).toEqual([]);
    expect(await nestedWorktreePathspec(root)).toEqual([]);
  });
});
