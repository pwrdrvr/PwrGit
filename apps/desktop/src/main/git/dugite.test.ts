import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PwrGitError } from "@pwrgit/shared";
import {
  execGit,
  execGitRecords,
  gitExecutionEnvironment,
  gitProcessInvocation,
  sanitizeGitLogDetail,
  settleOnGitExit
} from "./dugite";

describe("gitExecutionEnvironment", () => {
  it("disables terminal credentials while preserving caller overlays", () => {
    expect(
      gitExecutionEnvironment({
        GIT_OPTIONAL_LOCKS: "0",
        CUSTOM_SETTING: "kept"
      })
    ).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_OPTIONAL_LOCKS: "0",
      CUSTOM_SETTING: "kept"
    });
  });

  it("does not let caller overrides re-enable credential prompts", () => {
    expect(
      gitExecutionEnvironment({
        GIT_TERMINAL_PROMPT: "1",
        GCM_INTERACTIVE: "Auto"
      })
    ).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    });
  });
});

describe("gitProcessInvocation", () => {
  it("uses git -C without inheriting a deletable worktree as native cwd", () => {
    const worktree = join(tmpdir(), "fixture", "worktree");

    expect(gitProcessInvocation(["status", "--short"], worktree)).toEqual({
      args: ["-C", worktree, "status", "--short"],
      processCwd: tmpdir()
    });
  });
});

describe("execGit aborts", () => {
  it("preserves the typed abort reason instead of reporting spawn_failed", async () => {
    const timeout: PwrGitError = {
      kind: "remote",
      code: "pull_stalled",
      message: "Pull stopped during fetching after 15m 0s."
    };
    const controller = new AbortController();
    controller.abort(timeout);

    await expect(
      execGit(["status"], "/unused", { signal: controller.signal })
    ).resolves.toEqual({ ok: false, error: timeout });
  });
});

describe("execGitRecords", () => {
  it("discards ordinary records and stops after the bounded match count", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pwrgit-record-stream-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repo });
      for (let index = 0; index < 100; index += 1) {
        writeFileSync(join(repo, `ordinary-${index}.txt`), "ordinary\n");
      }
      execFileSync("git", ["add", "."], { cwd: repo });
      for (const path of ["modules/a", "modules/b"]) {
        execFileSync(
          "git",
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${"a".repeat(40)},${path}`
          ],
          { cwd: repo }
        );
      }

      const result = await execGitRecords(
        ["ls-files", "--stage", "-z"],
        repo,
        {
          maxRecords: 1,
          maxChars: 64_000,
          matches: (record) => record.startsWith("160000 ")
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.records).toHaveLength(1);
      expect(result.value.records[0]).toMatch(/^160000 /);
      expect(result.value.truncated).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("settleOnGitExit", () => {
  /**
   * A process that exits immediately after leaving behind a descendant which
   * inherited its stdio — the shape Git-for-Windows' launcher produces, and
   * the one that made `close` the wrong event to await. Node stands in for
   * `git` so the test says the same thing on every platform.
   */
  function exitsLeavingAPipeHolder(holdMs: number): ReturnType<typeof spawn> {
    const script = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${holdMs})'], {`,
      "  stdio: 'inherit',",
      "  detached: true",
      "}).unref();",
      "process.stdout.write('from git itself');"
    ].join("\n");
    return spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  it("answers when git exits, not when the last pipe holder lets go", async () => {
    const child = exitsLeavingAPipeHolder(4_000);
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));

    const startedAt = Date.now();
    const exitCode = await new Promise<number | null>((resolve) =>
      settleOnGitExit(child, resolve)
    );
    const elapsed = Date.now() - startedAt;

    expect(exitCode).toBe(0);
    // Awaiting `close` here would have taken the grandchild's full 4s.
    expect(elapsed).toBeLessThan(3_000);
    // And the grace window is what makes that safe: git's own bytes are in.
    expect(Buffer.concat(stdout).toString()).toBe("from git itself");
  }, 30_000);

  it("stops accumulating once it has answered", async () => {
    const child = exitsLeavingAPipeHolder(2_000);
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));

    await new Promise<number | null>((resolve) =>
      settleOnGitExit(child, resolve)
    );
    const atSettle = Buffer.concat(stdout).toString();
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    // The pipes are dropped at settle, so a grandchild that outlives the
    // answer cannot keep appending to a buffer nobody will read again.
    expect(Buffer.concat(stdout).toString()).toBe(atSettle);
  }, 30_000);
});

describe("sanitizeGitLogDetail", () => {
  it("redacts common URL, header, query, and GitHub token credentials", () => {
    const detail = sanitizeGitLogDetail(
      "fatal: https://harold:secret@example.com/repo?token=abc123\n" +
        "Authorization: Bearer secret\n" +
        "ghp_1234567890abcdef"
    );

    expect(detail).toContain("https://[redacted]@example.com/repo");
    expect(detail).toContain("token=[redacted]");
    expect(detail).toContain("Authorization: [redacted]");
    expect(detail).toContain("[redacted credential]");
    expect(detail).not.toContain("secret");
    expect(detail).not.toContain("1234567890abcdef");
  });
});
