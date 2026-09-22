import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import dugite from "dugite";
import {
  configureBundledGit,
  configureBundledGitConfig,
  gitExecutionEnvironment,
  bundledGitPath,
  execGit,
  execGitBinary,
  execGitRecords,
  installedGitEnvironment,
  installedGitSelection,
  useInstalledGit,
  type GitLaunch
} from "./dugite";
import { probeGitRuntime, readGitRuntimeStatus, selectGitRuntime, type GitDiscoveryDeps } from "./runtime-status";

const posix = process.platform !== "win32";
const scratch: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  configureBundledGit(dugite.resolveEmbeddedGitDir());
  configureBundledGitConfig(null);
  useInstalledGit(null);
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  scratch.push(directory);
  return directory;
}

/** A stand-in for an installed Git: prints what it was run with, and answers
 *  `lfs version` only when it has LFS. */
async function fakeGit(options: { lfs?: boolean } = {}): Promise<string> {
  const directory = await temporary("pwrgit-installed-git-");
  const git = join(directory, "git");
  await writeFile(git, [
    "#!/bin/sh",
    "for last in \"$@\"; do :; done",
    "if [ \"$1\" = --version ] || [ \"$last\" = --version ]; then echo 'git version 9.9.9-fixture'; exit 0; fi",
    "if [ \"$last\" = -z ]; then printf 'installed-fixture\\0'; exit 0; fi",
    "if [ \"$last\" = version ]; then",
    options.lfs === false ? "  echo 'git: lfs is not a git command' >&2; exit 1" : "  echo 'git-lfs/9.9.9 (fixture)'; exit 0",
    "fi",
    "echo \"args=$*\"",
    "echo \"GIT_EXEC_PATH=${GIT_EXEC_PATH:-unset}\"",
    "echo \"GIT_CONFIG_SYSTEM=${GIT_CONFIG_SYSTEM:-unset}\"",
    "echo \"LOCAL_GIT_DIRECTORY=${LOCAL_GIT_DIRECTORY:-unset}\"",
    "echo \"GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT:-unset}\"",
    "echo \"PATH=$PATH\"",
    ""
  ].join("\n"));
  await chmod(git, 0o755);
  return git;
}

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

  it("hydrates an LFS object with only the bundle's defaults — no `lfs install`, no global config", async () => {
    const cwd = await temporary("pwrgit-bundled-lfs-");
    configureBundledGitConfig(await temporary("pwrgit-gitconfig-"));
    vi.stubEnv("PATH", "");
    vi.stubEnv("LOCAL_GIT_DIRECTORY", "/invalid");
    vi.stubEnv("GIT_EXEC_PATH", "/invalid");
    const run = async (args: string[]) => {
      const result = await execGit(args, cwd, { env: { GIT_CONFIG_GLOBAL: join(cwd, "no-global-config") } });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.stderr, args.join(" ")).not.toContain("not found");
      expect(result.value.exitCode, result.value.stderr).toBe(0);
      return result.value.stdout;
    };
    await run(["init"]);
    await run(["config", "core.autocrlf", "false"]);
    await writeFile(join(cwd, ".gitattributes"), "*.dat filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(join(cwd, "payload.dat"), "bundled LFS round trip\n");
    await run(["add", "."]);
    expect(await run(["show", ":payload.dat"])).toContain("version https://git-lfs.github.com/spec/v1");
    await unlink(join(cwd, "payload.dat"));
    await run(["checkout", "--", "payload.dat"]);
    expect(await readFile(join(cwd, "payload.dat"), "utf8")).toBe("bundled LFS round trip\n");
  });
});

describe.skipIf(!posix)("an installed Git chosen in Settings", () => {
  it("runs that Git for text, binary and streaming commands, with none of the bundle's environment", async () => {
    const git = await fakeGit();
    configureBundledGitConfig(await temporary("pwrgit-gitconfig-"));
    useInstalledGit(git);
    const text = await execGit(["status"], tmpdir(), { env: { GIT_TERMINAL_PROMPT: "1" } });
    if (!text.ok) throw new Error(text.error.message);
    const lines = text.value.stdout.split("\n");
    expect(lines).toContain(`args=-C ${tmpdir()} status`);
    expect(lines).toContain("GIT_EXEC_PATH=unset");
    expect(lines).toContain("GIT_CONFIG_SYSTEM=unset");
    expect(lines).toContain("LOCAL_GIT_DIRECTORY=unset");
    // A caller still cannot re-enable prompts.
    expect(lines).toContain("GIT_TERMINAL_PROMPT=0");
    const path = lines.find((line) => line.startsWith("PATH="))?.slice(5).split(delimiter) ?? [];
    expect(path[0]).toBe(dirname(git));
    expect(path.some((entry) => entry.startsWith(dugite.resolveEmbeddedGitDir()))).toBe(false);

    const binary = await execGitBinary(["status"], tmpdir());
    expect(binary.ok && binary.value.stdout.toString()).toContain(`args=-C ${tmpdir()} status`);
    const stream = await execGitRecords(["ls-files", "-z"], tmpdir(), { matches: () => true, maxRecords: 10, maxChars: 10_000 });
    expect(stream.ok && stream.value.records).toEqual(["installed-fixture"]);
  });

  it("fails naming the choice when it breaks, and never falls back to the bundle", async () => {
    const missing = join(await temporary("pwrgit-removed-git-"), "git");
    useInstalledGit(missing);
    const result = await execGit(["--version"], tmpdir());
    expect(result).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.message).toContain(missing);
    expect(result.error.message).toContain("Settings");
    const stream = await execGitRecords(["ls-files", "-z"], tmpdir(), { matches: () => true, maxRecords: 1, maxChars: 100 });
    expect(stream).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
    expect(stream.ok ? "" : stream.error.message).toContain("Settings");
  });

  it("keeps a GIT_CONFIG_SYSTEM of the user's own, and drops the bundle's and the generated one", async () => {
    const generated = await temporary("pwrgit-gitconfig-");
    configureBundledGitConfig(generated);
    const bundle = dugite.resolveEmbeddedGitDir();
    const own = installedGitEnvironment({ GIT_CONFIG_SYSTEM: "/etc/custom-gitconfig", PATH: "" }, "/opt/fixture/bin/git");
    expect(own.GIT_CONFIG_SYSTEM).toBe("/etc/custom-gitconfig");
    for (const config of [join(bundle, "etc", "gitconfig"), join(generated, "gitconfig-abc")]) {
      expect(installedGitEnvironment({ GIT_CONFIG_SYSTEM: config, PATH: "" }, "/opt/fixture/bin/git").GIT_CONFIG_SYSTEM).toBeUndefined();
    }
  });
});

/** A machine that exists only in this test. */
function fakeMachine(files: Record<string, { git?: string; lfs?: string }>, overrides: Partial<GitDiscoveryDeps> = {}): GitDiscoveryDeps & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    platform: "darwin",
    home: "/Users/fixture",
    searchPath: () => "/usr/bin:/opt/homebrew/bin",
    executable: async (path) => path in files,
    realpath: async (path) => path,
    developerDirectory: async () => null,
    probe: async (launch: GitLaunch, args: string[]) => {
      probed.push(launch.binary);
      const answers = files[launch.binary];
      const output = args[0] === "lfs" ? answers?.lfs : answers?.git;
      return output === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: output };
    },
    ...overrides
  };
}

const HEALTHY = { git: "git version 2.50.1", lfs: "git-lfs/3.7.0 (GitHub; darwin arm64; go 1.24.0)" };

describe("Git discovery", () => {
  it("lists the bundle first, then each install once under its most specific name", async () => {
    const machine = fakeMachine({
      [bundledGitPath()]: { git: "git version 2.53.0", lfs: "git-lfs/3.7.1" },
      "/opt/homebrew/bin/git": HEALTHY,
      "/Users/fixture/.local/bin/git": { git: "git version 2.44.0" }
    });
    const status = await readGitRuntimeStatus(machine);
    expect(status.active).toBe("bundled");
    expect(status.path).toBe(bundledGitPath());
    expect(status.candidates.map(({ path, source, problem }) => [path, source, problem])).toEqual([
      [bundledGitPath(), "bundled", null],
      // Also first on PATH; it keeps reading "Homebrew" and appears once.
      ["/opt/homebrew/bin/git", "homebrew", null],
      ["/Users/fixture/.local/bin/git", "user", "lfs_missing"]
    ]);
  });

  it("never runs Apple's shim, and lists the Git behind it only when it is there", async () => {
    const apple = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";
    const none = fakeMachine({ [bundledGitPath()]: HEALTHY, "/usr/bin/git": HEALTHY });
    const without = await readGitRuntimeStatus(none);
    expect(without.candidates.map((candidate) => candidate.source)).toEqual(["bundled"]);
    expect(none.probed).not.toContain("/usr/bin/git");

    const tools = fakeMachine(
      { [bundledGitPath()]: HEALTHY, "/usr/bin/git": HEALTHY, [apple]: HEALTHY },
      { developerDirectory: async () => "/Applications/Xcode.app/Contents/Developer" }
    );
    const withTools = await readGitRuntimeStatus(tools);
    expect(withTools.candidates.map(({ path, source }) => [path, source])).toEqual([
      [bundledGitPath(), "bundled"],
      [apple, "xcode"]
    ]);
    expect(tools.probed).not.toContain("/usr/bin/git");
  });

  it("gives a chosen Git discovery would not find a row of its own, broken or not", async () => {
    useInstalledGit("/opt/elsewhere/bin/git");
    const status = await readGitRuntimeStatus(fakeMachine({ [bundledGitPath()]: HEALTHY }));
    expect(status.active).toBe("installed");
    expect(status.path).toBe("/opt/elsewhere/bin/git");
    expect(status.candidates.at(-1)).toEqual({
      path: "/opt/elsewhere/bin/git", source: "custom", git: null, lfs: null, problem: "not_found"
    });
  });

  it("calls a Git that does not answer --version unusable", async () => {
    const machine = fakeMachine({ "/opt/hub": { git: "hub version 2.14.2" } });
    expect((await probeGitRuntime("/opt/hub", "custom", machine)).problem).toBe("no_version");
  });
});

describe("selectGitRuntime", () => {
  const settings = () => ({ update: vi.fn() });

  it("probes, then saves and applies an installed Git", async () => {
    const store = settings();
    const machine = fakeMachine({ "/opt/homebrew/bin/git": HEALTHY });
    expect(await selectGitRuntime(store, "/opt/homebrew/bin/git", machine)).toEqual({ ok: true, value: null });
    expect(store.update).toHaveBeenCalledWith({ gitPath: "/opt/homebrew/bin/git" });
    expect(installedGitSelection()).toBe("/opt/homebrew/bin/git");
  });

  it("refuses a Git without LFS, and changes nothing", async () => {
    const store = settings();
    const result = await selectGitRuntime(store, "/usr/local/bin/git", fakeMachine({ "/usr/local/bin/git": { git: "git version 2.39.5" } }));
    expect(result).toMatchObject({ ok: false, error: { code: "git_runtime_lfs_missing" } });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.message).toContain("Git LFS");
    expect(store.update).not.toHaveBeenCalled();
    expect(installedGitSelection()).toBeNull();
  });

  it("refuses a relative path before probing anything", async () => {
    const machine = fakeMachine({});
    const result = await selectGitRuntime(settings(), "bin/git", machine);
    expect(result).toMatchObject({ ok: false, error: { code: "git_runtime_relative" } });
    expect(machine.probed).toEqual([]);
  });

  it("returns to the bundle for null, a blank path, or the bundle's own path", async () => {
    for (const path of [null, "  ", bundledGitPath()]) {
      useInstalledGit("/opt/homebrew/bin/git");
      const store = settings();
      expect(await selectGitRuntime(store, path, fakeMachine({}))).toEqual({ ok: true, value: null });
      expect(store.update).toHaveBeenCalledWith({ gitPath: undefined });
      expect(installedGitSelection()).toBeNull();
    }
  });
});
