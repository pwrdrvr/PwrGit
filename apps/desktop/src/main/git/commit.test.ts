import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { commitChanges, stagePaths, unstagePaths } from "./git-service";

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

function gitOut(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

let repo: string;

beforeAll(() => {
  repo = join(mkdtempSync(join(tmpdir(), "pwrgit-commit-")), "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  // Intentionally do NOT configure user.email/name — the commit identity must
  // come from the per-commit override.
});

describe("commit flow", () => {
  it("commits under the per-commit identity without writing repo config", async () => {
    writeFileSync(join(repo, "a.txt"), "1\n");
    expect((await stagePaths(systemGit, repo, ["a.txt"])).ok).toBe(true);

    const result = await commitChanges(systemGit, repo, "feat: a", {
      email: "custom@acme.io",
      name: "Custom Name"
    });
    expect(result.ok).toBe(true);

    expect(gitOut(repo, ["log", "-1", "--format=%ae"])).toBe("custom@acme.io");
    expect(gitOut(repo, ["log", "-1", "--format=%an"])).toBe("Custom Name");

    // Repo-local config must remain unset (non-mutating identity).
    let configEmail = "";
    try {
      configEmail = gitOut(repo, ["config", "--local", "user.email"]);
    } catch {
      configEmail = "";
    }
    expect(configEmail).toBe("");
  });

  it("stage then unstage removes a file from the index", async () => {
    writeFileSync(join(repo, "b.txt"), "2\n");
    await stagePaths(systemGit, repo, ["b.txt"]);
    await unstagePaths(systemGit, repo, ["b.txt"]);
    expect(gitOut(repo, ["status", "--porcelain"])).toContain("?? b.txt");
  });

  it("rejects a commit with nothing staged", async () => {
    const result = await commitChanges(systemGit, repo, "empty", {
      email: "x@y.com"
    });
    expect(result.ok).toBe(false);
  });
});
