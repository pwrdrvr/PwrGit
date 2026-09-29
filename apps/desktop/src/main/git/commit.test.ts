import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GitExec } from "./dugite";
import { commitChanges, stagePaths, unstagePaths } from "./git-service";
import { createSystemGit } from "./test-support/system-git";

const systemGit: GitExec = createSystemGit();

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

  it("reports the hook Git ran and permits a guarded one-time retry with --no-verify", async () => {
    writeFileSync(join(repo, "hooked.txt"), "hooked\n");
    await stagePaths(systemGit, repo, ["hooked.txt"]);
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'test hook rejected' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    let capturedTrace = "Git did not pass a trace path to the executor";
    const tracedGit: GitExec = async (args, cwd, options) => {
      const result = await systemGit(args, cwd, options);
      const path = options?.env?.GIT_TRACE2_EVENT;
      if (path !== undefined) {
        capturedTrace = existsSync(path) ? readFileSync(path, "utf8") : `No trace file at ${path}`;
      }
      return result;
    };
    const refused = await commitChanges(tracedGit, repo, "feat: hooked", { email: "x@y.com" });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    if (refused.error.hook === undefined) throw new Error(`Git ran the refusing hook without a parsed receipt: ${capturedTrace}`);
    expect(refused.error.hook).toMatchObject({ name: "pre-commit", exitCode: 1 });
    expect(refused.error.hook?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(refused.error.detail).toContain("test hook rejected");
    expect(gitOut(repo, ["status", "--porcelain"])).toContain("A  hooked.txt");

    const retry = await commitChanges(systemGit, repo, "feat: hooked", { email: "x@y.com" }, { noVerify: true });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.error.message);
    expect(retry.value.hooks).toEqual([]);
    expect(readFileSync(hook, "utf8")).toContain("exit 1");
  });
});
