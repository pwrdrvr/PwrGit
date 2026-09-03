import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { StashWatch } from "./stash-watch";

const systemGit: GitExec = (args, cwd, options) =>
  new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...process.env, ...options?.env }
    });
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

describe("StashWatch (system git)", () => {
  let root: string;
  let repo: string;
  let linked: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-stash-watch-"));
    repo = join(root, "repo");
    linked = join(root, "linked");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "PwrGit Test"]);
    git(repo, ["config", "user.email", "pwrgit@example.com"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "tracked.txt"), "baseline\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
    git(repo, ["worktree", "add", "-b", "other", linked]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sees a CLI-created stash made in another linked worktree", async () => {
    const watch = new StashWatch(systemGit);
    await expect(watch.hasChanged("repo-1", repo)).resolves.toBe(true);
    await expect(watch.hasChanged("repo-1", repo)).resolves.toBe(false);

    writeFileSync(join(linked, "tracked.txt"), "from linked worktree\n");
    git(linked, ["stash", "push", "-m", "CLI after launch"]);

    await expect(watch.hasChanged("repo-1", repo)).resolves.toBe(true);
    await expect(watch.hasChanged("repo-1", linked)).resolves.toBe(false);
  });

  it("fingerprints the complete stack so a non-top drop is visible", async () => {
    writeFileSync(join(repo, "tracked.txt"), "older\n");
    git(repo, ["stash", "push", "-m", "older"]);
    writeFileSync(join(repo, "tracked.txt"), "newer\n");
    git(repo, ["stash", "push", "-m", "newer"]);
    const tip = git(repo, ["rev-parse", "refs/stash"]);
    const watch = new StashWatch(systemGit);
    await watch.hasChanged("repo-1", repo);

    git(linked, ["stash", "drop", "stash@{1}"]);

    expect(git(repo, ["rev-parse", "refs/stash"])).toBe(tip);
    await expect(watch.hasChanged("repo-1", repo)).resolves.toBe(true);
  });
});
