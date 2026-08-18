import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANGE_LIST_LIMIT,
  err,
  ok,
  type ChangeSet,
  type FileChange
} from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  capChangeSet,
  discardPaths,
  readChanges,
  stagePaths
} from "./git-service";
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

describe("capChangeSet", () => {
  const untracked = (path: string): FileChange => ({
    path,
    status: "?",
    staged: false
  });
  const set = (unstaged: FileChange[], staged: FileChange[] = []): ChangeSet => ({
    staged,
    unstaged
  });

  it("leaves a list that fits completely alone", () => {
    const small = set([untracked("a.txt"), untracked("b.txt")]);

    const capped = capChangeSet(small, 10);

    expect(capped).toBe(small);
    expect(capped.truncated).toBeUndefined();
  });

  it("caps each section and reports the real totals", () => {
    const many = set(
      Array.from({ length: 12 }, (_, i) => untracked(`dist/f${i}.js`)),
      Array.from({ length: 5 }, (_, i) => ({
        path: `src/s${i}.ts`,
        status: "A" as const,
        staged: true
      }))
    );

    const capped = capChangeSet(many, 4);

    expect(capped.unstaged).toHaveLength(4);
    expect(capped.staged).toHaveLength(4);
    expect(capped.truncated).toEqual({
      staged: 5,
      unstaged: 12,
      largestUntrackedFolder: { dir: "dist", count: 12 }
    });
  });

  it("names the biggest folder from the whole list, not the surviving slice", () => {
    // `assets` sorts first and fills the entire cap, but `dist` is the folder
    // actually worth ignoring — picking from the slice would name the wrong one.
    const many = set([
      ...Array.from({ length: 3 }, (_, i) => untracked(`assets/a${i}.png`)),
      ...Array.from({ length: 40 }, (_, i) => untracked(`dist/f${i}.js`))
    ]);

    expect(capChangeSet(many, 3).truncated?.largestUntrackedFolder).toEqual({
      dir: "dist",
      count: 40
    });
  });

  it("has no folder to blame when the flood is tracked edits", () => {
    const many = set(
      Array.from({ length: 9 }, (_, i) => ({
        path: `src/f${i}.ts`,
        status: "M" as const,
        staged: false
      }))
    );

    expect(capChangeSet(many, 4).truncated?.largestUntrackedFolder).toBeNull();
  });
});

describe("readChanges cap (system git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-cap-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    writeFileSync(join(repo, "tracked.txt"), "baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("hands the renderer a bounded list and the count it stands for", async () => {
    mkdirSync(join(repo, "dist"));
    const total = CHANGE_LIST_LIMIT + 25;
    for (let i = 0; i < total; i += 1) {
      writeFileSync(join(repo, "dist", `f${i}.js`), "x\n");
    }

    const changes = await readChanges(systemGit, repo);
    if (!changes.ok) throw new Error(changes.error.message);

    expect(changes.value.unstaged).toHaveLength(CHANGE_LIST_LIMIT);
    expect(changes.value.truncated?.unstaged).toBe(total);
    expect(changes.value.truncated?.largestUntrackedFolder).toEqual({
      dir: "dist",
      count: total
    });
  });
});

describe("discardPaths (system git)", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-discard-paths-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "kept.ts"), "baseline\n");
    writeFileSync(join(repo, "src", "edited.ts"), "baseline\n");
    writeFileSync(join(repo, "src", "removed.ts"), "baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /**
   * One folder row, every kind of change under it. Tracked files go back to
   * their HEAD content (including one deleted from disk), new files are
   * removed — and the untouched file beside them is left completely alone.
   */
  it("discards a folder's mixed changes in one go", async () => {
    writeFileSync(join(repo, "src", "edited.ts"), "local edit\n");
    unlinkSync(join(repo, "src", "removed.ts"));
    writeFileSync(join(repo, "src", "brand-new.ts"), "new\n");
    writeFileSync(join(repo, "src", "staged-new.ts"), "new\n");
    git(repo, ["add", "src/staged-new.ts"]);

    await expect(
      discardPaths(systemGit, repo, [
        "src/edited.ts",
        "src/removed.ts",
        "src/brand-new.ts",
        "src/staged-new.ts"
      ])
    ).resolves.toEqual(ok(undefined));

    expect(readFileSync(join(repo, "src", "edited.ts"), "utf8")).toBe(
      "baseline\n"
    );
    expect(readFileSync(join(repo, "src", "removed.ts"), "utf8")).toBe(
      "baseline\n"
    );
    expect(existsSync(join(repo, "src", "brand-new.ts"))).toBe(false);
    expect(existsSync(join(repo, "src", "staged-new.ts"))).toBe(false);
    expect(readFileSync(join(repo, "src", "kept.ts"), "utf8")).toBe(
      "baseline\n"
    );

    const changes = await readChanges(systemGit, repo);
    expect(changes.ok && changes.value).toEqual({ staged: [], unstaged: [] });
  });

  it("leaves files outside the named paths untouched", async () => {
    writeFileSync(join(repo, "src", "edited.ts"), "local edit\n");
    writeFileSync(join(repo, "src", "kept.ts"), "also edited\n");

    await discardPaths(systemGit, repo, ["src/edited.ts"]);

    expect(readFileSync(join(repo, "src", "kept.ts"), "utf8")).toBe(
      "also edited\n"
    );
  });

  it("treats everything as new when HEAD is unborn", async () => {
    const fresh = join(root, "unborn");
    mkdirSync(fresh);
    git(fresh, ["init", "-b", "main"]);
    writeFileSync(join(fresh, "first.txt"), "x\n");
    git(fresh, ["add", "."]);

    await expect(
      discardPaths(systemGit, fresh, ["first.txt"])
    ).resolves.toEqual(ok(undefined));

    expect(existsSync(join(fresh, "first.txt"))).toBe(false);
  });

  it("does nothing, successfully, for an empty path list", async () => {
    writeFileSync(join(repo, "src", "edited.ts"), "local edit\n");

    await expect(discardPaths(systemGit, repo, [])).resolves.toEqual(
      ok(undefined)
    );

    expect(readFileSync(join(repo, "src", "edited.ts"), "utf8")).toBe(
      "local edit\n"
    );
  });
});
