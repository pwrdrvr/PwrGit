import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@pwrgit/shared";
import type {
  GitBinaryOutput,
  GitExec,
  GitExecBinary,
  GitOutput
} from "./dugite";

const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0"
};

/** System-git adapter used by deterministic conflict integration tests. */
export const conflictSystemGit: GitExec = (args, cwd, options) =>
  new Promise((resolvePromise) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...ISOLATED_GIT_ENV, ...options?.env }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolvePromise(
        err({ kind: "git", code: "spawn_failed", message: cause.message })
      )
    );
    proc.on("close", (exitCode) =>
      resolvePromise(
        ok({ stdout, stderr, exitCode: exitCode ?? 1 } satisfies GitOutput)
      )
    );
  });

export const conflictSystemGitBinary: GitExecBinary = (args, cwd) =>
  new Promise((resolvePromise) => {
    const proc = spawn("git", args, { cwd, env: ISOLATED_GIT_ENV });
    const stdout: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (cause) =>
      resolvePromise(
        err({ kind: "git", code: "spawn_failed", message: cause.message })
      )
    );
    proc.on("close", (exitCode) =>
      resolvePromise(
        ok({
          stdout: Buffer.concat(stdout),
          stderr,
          exitCode: exitCode ?? 1
        } satisfies GitBinaryOutput)
      )
    );
  });

export type ConflictTestOperation =
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert";

export type ConflictTestFixture = {
  root: string;
  repo: string;
  mainHead: string;
  topicHead: string;
  run: (...args: string[]) => string;
  start: (operation: ConflictTestOperation) => void;
  cleanup: () => void;
};

/**
 * Real Git history with two deterministic text conflicts and an unrelated file.
 * Each fixture starts from main and can enter exactly one operation.
 */
export function createConflictTestFixture(): ConflictTestFixture {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-conflict-"));
  const repo = join(root, "repo");
  mkdirSync(repo);

  const result = (...args: string[]) =>
    spawnSync("git", args, {
      cwd: repo,
      env: ISOLATED_GIT_ENV,
      encoding: "utf8"
    });
  const run = (...args: string[]): string => {
    const completed = result(...args);
    if (completed.status !== 0) {
      throw new Error(completed.stderr || `git ${args.join(" ")} failed`);
    }
    return completed.stdout.trim();
  };
  const expectConflict = (...args: string[]): void => {
    const completed = result(...args);
    if (completed.status === 0) {
      throw new Error(`git ${args.join(" ")} unexpectedly completed cleanly`);
    }
    if (!completed.stdout.includes("CONFLICT") && !completed.stderr.includes("CONFLICT")) {
      throw new Error(
        completed.stderr || completed.stdout || `git ${args.join(" ")} did not report a conflict`
      );
    }
  };

  run("init", "-b", "main");
  run("config", "user.name", "PwrGit Test");
  run("config", "user.email", "test@pwrgit.dev");
  run("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "alpha.txt"), "base alpha\n");
  writeFileSync(join(repo, "beta.txt"), "base beta\n");
  writeFileSync(join(repo, "keep.txt"), "keep baseline\n");
  run("add", "-A");
  run("commit", "-m", "base");

  run("switch", "-c", "topic");
  writeFileSync(join(repo, "alpha.txt"), "topic alpha\n");
  writeFileSync(join(repo, "beta.txt"), "topic beta\n");
  run("add", "-A");
  run("commit", "-m", "topic changes");
  const topicHead = run("rev-parse", "HEAD");

  run("switch", "main");
  writeFileSync(join(repo, "alpha.txt"), "main alpha\n");
  writeFileSync(join(repo, "beta.txt"), "main beta\n");
  run("add", "-A");
  run("commit", "-m", "main changes");
  const mainHead = run("rev-parse", "HEAD");

  return {
    root,
    repo,
    mainHead,
    topicHead,
    run,
    start: (operation) => {
      if (operation === "merge") {
        expectConflict("merge", "--no-edit", "topic");
      } else if (operation === "rebase") {
        run("switch", "topic");
        expectConflict("rebase", "main");
      } else if (operation === "cherry-pick") {
        expectConflict("cherry-pick", topicHead);
      } else {
        expectConflict("revert", "--no-edit", topicHead);
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}
