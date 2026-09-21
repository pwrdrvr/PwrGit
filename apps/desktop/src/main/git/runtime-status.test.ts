import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dugite from "dugite";
import { ok } from "@pwrgit/shared";
import { configureBundledGit, gitExecutionEnvironment, bundledGitPath, execGit, execGitBinary, execGitRecords } from "./dugite";
import { readGitRuntimeStatus } from "./runtime-status";

afterEach(() => { vi.unstubAllEnvs(); configureBundledGit(dugite.resolveEmbeddedGitDir()); });

describe("bundled Git runtime", () => {
  it("uses the packaged resources directory without mutating the parent environment", () => {
    vi.stubEnv("LOCAL_GIT_DIRECTORY", "/parent-runtime");
    const directory = join(tmpdir(), "fixture-app", "resources", "git");
    configureBundledGit(directory);
    expect(bundledGitPath()).toBe(dugite.resolveGitBinary(directory));
    expect(gitExecutionEnvironment()).toMatchObject({
      LOCAL_GIT_DIRECTORY: directory,
      GIT_EXEC_PATH: dugite.resolveGitExecPath(directory, "")
    });
    expect(process.env.LOCAL_GIT_DIRECTORY).toBe("/parent-runtime");
  });
  it("pins text, binary and streaming Git despite inherited and per-call redirects", async () => {
    vi.stubEnv("LOCAL_GIT_DIRECTORY", join(tmpdir(), "nonexistent-git"));
    vi.stubEnv("GIT_EXEC_PATH", join(tmpdir(), "nonexistent-helpers"));
    vi.stubEnv("PATH", "");
    const env = { LOCAL_GIT_DIRECTORY: "/invalid", GIT_EXEC_PATH: "/invalid" };
    const text = await execGit(["--version"], tmpdir(), { env });
    expect(text).toMatchObject({ ok: true, value: { exitCode: 0 } });
    if (!text.ok) throw new Error(text.error.message);
    expect(text.value.stdout).toMatch(/^git version /);
    const binary = await execGitBinary(["--version"], tmpdir());
    expect(binary.ok && binary.value.stdout.toString()).toBe(text.value.stdout);
    const stream = await execGitRecords(["--version"], tmpdir(), {
      env, matches: () => true, maxRecords: 10, maxChars: 10_000
    });
    expect(stream).toMatchObject({ ok: true, value: { exitCode: 0 } });
    const lfs = await execGit(["lfs", "version"], tmpdir());
    expect(lfs.ok && lfs.value.stdout).toMatch(/^git-lfs\//);
  });

  it("materializes an LFS object without installed Git or LFS on PATH", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pwrgit-bundled-lfs-"));
    vi.stubEnv("PATH", "");
    vi.stubEnv("LOCAL_GIT_DIRECTORY", "/invalid");
    vi.stubEnv("GIT_EXEC_PATH", "/invalid");
    const run = async (args: string[]) => {
      const result = await execGit(args, cwd, { env: { GIT_CONFIG_GLOBAL: join(cwd, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" } });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.stderr, args.join(" ")).not.toContain("not found");
      expect(result.value.exitCode, result.value.stderr).toBe(0);
      return result.value.stdout;
    };
    try {
      await run(["init"]);
      await run(["config", "core.autocrlf", "false"]);
      await run(["lfs", "install", "--local"]);
      await writeFile(join(cwd, ".gitattributes"), "*.dat filter=lfs diff=lfs merge=lfs -text\n");
      await writeFile(join(cwd, "payload.dat"), "bundled LFS round trip\n");
      await run(["add", "."]);
      expect(await run(["show", ":payload.dat"])).toContain("version https://git-lfs.github.com/spec/v1");
      await unlink(join(cwd, "payload.dat"));
      await run(["checkout", "--", "payload.dat"]);
      expect(await readFile(join(cwd, "payload.dat"), "utf8")).toBe("bundled LFS round trip\n");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("reports installed versions without selecting them", async () => {
    const git = vi.fn(async (args: string[]) => ok({ stdout: args[0] === "lfs" ? "git-lfs/3.fixture\n" : "git version 2.fixture\n", stderr: "", exitCode: 0 }));
    const installed = vi.fn(async (binary: string) => `${binary} installed fixture`);
    const status = await readGitRuntimeStatus(git, installed);
    expect(status).toEqual({
      active: "bundled", default: "bundled", path: bundledGitPath(),
      bundled: { git: "git version 2.fixture", lfs: "git-lfs/3.fixture" },
      installed: { git: "git installed fixture", lfs: "git-lfs installed fixture" }
    });
    expect(bundledGitPath()).toBe(status.path);
  });

  it("reports a broken bundle without falling back to installed Git", async () => {
    const status = await readGitRuntimeStatus(async () => ok({ stdout: "", stderr: "missing", exitCode: 1 }), async () => "installed");
    expect(status.bundled).toEqual({ git: null, lfs: null });
    expect(status.active).toBe("bundled");
  });
});
