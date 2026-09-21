import { afterEach, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { runCommand } from "./command.js";

afterEach(() => vi.unstubAllEnvs());

it("standalone MCP uses bundled Git and LFS with no installed runtime", async () => {
  vi.stubEnv("PATH", "");
  vi.stubEnv("LOCAL_GIT_DIRECTORY", "/invalid");
  vi.stubEnv("GIT_EXEC_PATH", "/invalid");
  const git = await runCommand("git", ["--version"], { cwd: tmpdir() });
  expect(git.exitCode).toBe(0);
  expect(git.stdout).toMatch(/^git version /);
  const lfs = await runCommand("git", ["lfs", "version"], { cwd: tmpdir(), env: { LOCAL_GIT_DIRECTORY: "/invalid", GIT_EXEC_PATH: "/invalid" } });
  expect(lfs.exitCode).toBe(0);
  expect(lfs.stdout).toMatch(/^git-lfs\//);
});
