import { tmpdir } from "node:os";
import { ok } from "@pwrgit/shared";
import { afterEach, expect, it, vi } from "vitest";
import { execGit, type GitExec } from "../git/dugite";
import { createDesktopMcpRunner } from "./desktop-mcp-runner";

afterEach(() => vi.unstubAllEnvs());

it("runs bundled Git with no Git on PATH", async () => {
  const fallback = vi.fn().mockRejectedValue(new Error("PATH runner must not execute Git"));
  const bundled: GitExec = (args, cwd, options) => execGit(args, cwd, {
    ...options, env: { ...options?.env, PATH: "" }
  });
  const result = await createDesktopMcpRunner(bundled, fallback)("git", ["--version"], { cwd: tmpdir() });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^git version /);
  expect(fallback).not.toHaveBeenCalled();
});

it("preserves Git results and delegates forge commands", async () => {
  vi.stubEnv("PATH", "/usr/bin:/bin");
  const output = { exitCode: 1, stdout: "", stderr: "missing ref" };
  const git = vi.fn<GitExec>().mockResolvedValue(ok(output));
  const fallback = vi.fn().mockResolvedValue(output);
  const runner = createDesktopMcpRunner(git, fallback);
  expect(await runner("git", ["status"], { cwd: tmpdir() })).toEqual(output);
  expect(git).toHaveBeenCalledWith(["status"], tmpdir(), expect.objectContaining({
    env: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, signal: expect.any(AbortSignal)
  }));
  for (const command of ["gh", "glab"]) {
    await runner(command, ["version"], { cwd: tmpdir(), timeoutMs: 42 });
    expect(fallback).toHaveBeenCalledWith(command, ["version"], {
      cwd: tmpdir(), timeoutMs: 42,
      env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }
    });
  }
  expect(git).toHaveBeenCalledTimes(1);
});

it("aborts Git at the MCP command deadline", async () => {
  vi.useFakeTimers();
  try {
    const git: GitExec = (_args, _cwd, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const pending = createDesktopMcpRunner(git)("git", ["status"], { cwd: tmpdir(), timeoutMs: 50 });
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
