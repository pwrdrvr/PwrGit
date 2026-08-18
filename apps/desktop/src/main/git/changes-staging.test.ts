import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { readChanges, stagePaths } from "./git-service";
import { parseStatus } from "./worktree-state";

const systemGit: GitExec = (args, cwd) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolve(err({ kind: "git", code: "spawn_failed", message: cause.message }))
    );
    proc.on("close", (exitCode) =>
      resolve(ok({ stdout, stderr, exitCode: exitCode ?? 1 } satisfies GitOutput))
    );
  });

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

async function unstagedPaths(repo: string): Promise<string[]> {
  const changes = await readChanges(systemGit, repo);
  if (!changes.ok) throw new Error(changes.error.message);
  return changes.value.unstaged.map((f) => f.path);
}

async function stagedPaths(repo: string): Promise<string[]> {
  const changes = await readChanges(systemGit, repo);
  if (!changes.ok) throw new Error(changes.error.message);
  return changes.value.staged.map((f) => f.path);
}

describe("staging untracked work (system git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-staging-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    writeFileSync(join(repo, "tracked.txt"), "baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);

    // A wholly-new folder plus loose new files beside it — the shape that git's
    // default `-unormal` collapses into a single `design/` entry.
    mkdirSync(join(repo, "design", "handoff"), { recursive: true });
    writeFileSync(join(repo, "design", "handoff", "icon.swift"), "a\n");
    writeFileSync(join(repo, "design", "handoff", "tray.mjs"), "b\n");
    writeFileSync(join(repo, "design", "Background Comparison.html"), "c\n");
    writeFileSync(join(repo, "design", "github.md"), "d\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists every untracked file instead of one collapsed folder entry", async () => {
    await expect(unstagedPaths(repo)).resolves.toEqual([
      "design/Background Comparison.html",
      "design/github.md",
      "design/handoff/icon.swift",
      "design/handoff/tray.mjs"
    ]);
  });

  it("stages a whole folder from one directory path", async () => {
    await expect(
      stagePaths(systemGit, repo, [
        "design/handoff/icon.swift",
        "design/handoff/tray.mjs"
      ])
    ).resolves.toEqual(ok(undefined));

    await expect(stagedPaths(repo)).resolves.toEqual([
      "design/handoff/icon.swift",
      "design/handoff/tray.mjs"
    ]);
    await expect(unstagedPaths(repo)).resolves.toEqual([
      "design/Background Comparison.html",
      "design/github.md"
    ]);
  });

  it("still stages a single file after a folder was staged", async () => {
    await stagePaths(systemGit, repo, [
        "design/handoff/icon.swift",
        "design/handoff/tray.mjs"
      ]);
    await expect(
      stagePaths(systemGit, repo, ["design/Background Comparison.html"])
    ).resolves.toEqual(ok(undefined));

    await expect(stagedPaths(repo)).resolves.toContain(
      "design/Background Comparison.html"
    );
  });

  /**
   * Why `changes:changed` exists. The worktree refresher only emits
   * `worktree:changed` when the coarse state moved, and staging a file moves
   * none of it: the same path is still one status line, head and ahead/behind
   * are untouched. A Changes list that reloads on `worktree:changed` alone
   * therefore freezes after the first click — which is exactly what staging a
   * folder masked, since collapsing 2 files into 1 entry *did* change the count.
   */
  it("does not move the coarse worktree state the refresher compares", async () => {
    const dirty = async (): Promise<number> => {
      const raw = await systemGit(
        ["status", "--porcelain=v2", "--branch"],
        repo
      );
      if (!raw.ok) throw new Error(raw.error.message);
      return parseStatus(raw.value.stdout).dirty;
    };

    // The reported sequence: stage the folder first (that one *does* move the
    // count, which is why the first click appeared to work), then stage a file.
    await stagePaths(systemGit, repo, [
        "design/handoff/icon.swift",
        "design/handoff/tray.mjs"
      ]);
    const before = await dirty();
    await stagePaths(systemGit, repo, ["design/github.md"]);

    expect(await dirty()).toBe(before);
  });
});
