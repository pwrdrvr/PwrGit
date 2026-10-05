import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import dugite from "dugite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createSystemGit,
  createSystemGitBinary,
  systemGitLauncher,
  systemGitRuntime
} from "./system-git";

const bundle = resolve(dugite.resolveEmbeddedGitDir());
const inBundle = (path: string): boolean => {
  const inside = relative(bundle, resolve(path));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("systemGitRuntime", () => {
  it("is the bundle unless PWRGIT_TEST_GIT asks for the installed Git", () => {
    expect(systemGitRuntime({})).toBe("bundled");
    expect(systemGitRuntime({ PWRGIT_TEST_GIT: "" })).toBe("bundled");
    expect(systemGitRuntime({ PWRGIT_TEST_GIT: "bundled" })).toBe("bundled");
    expect(systemGitRuntime({ PWRGIT_TEST_GIT: "installed" })).toBe("installed");
  });

  it("rejects a value it does not know instead of testing the bundle under it", () => {
    expect(() => systemGitRuntime({ PWRGIT_TEST_GIT: "path" })).toThrow(
      'PWRGIT_TEST_GIT must be "bundled" or "installed", not "path".'
    );
  });
});

describe("systemGitLauncher", () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-system-git-"));
  const empty = join(root, "empty");
  const installed = join(root, "installed");
  const name = process.platform === "win32" ? "git.exe" : "git";
  mkdirSync(empty);
  mkdirSync(installed);
  // Only ever looked up, never run.
  writeFileSync(join(installed, name), "");
  chmodSync(join(installed, name), 0o755);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps prompting off for the bundle whatever a suite passes", () => {
    const launch = systemGitLauncher({ PATH: installed, GIT_TERMINAL_PROMPT: "1" }, "bundled")({
      GCM_INTERACTIVE: "Auto"
    });
    expect(launch.binary).toBe("git");
    expect(inBundle(launch.env.GIT_EXEC_PATH ?? "")).toBe(true);
    expect(launch.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" });
  });

  it("runs the first git on PATH with nothing of the bundle's, and prompting still off", () => {
    const launch = systemGitLauncher(
      {
        PATH: ["relative", empty, installed].join(delimiter),
        GIT_EXEC_PATH: join(bundle, "libexec", "git-core"),
        LOCAL_GIT_DIRECTORY: bundle,
        GIT_TERMINAL_PROMPT: "1"
      },
      "installed"
    )({ GCM_INTERACTIVE: "Auto" });
    expect(launch.binary).toBe(join(installed, name));
    expect(launch.env.GIT_EXEC_PATH).toBeUndefined();
    expect(launch.env.LOCAL_GIT_DIRECTORY).toBeUndefined();
    const path = (launch.env.PATH ?? "").split(delimiter);
    expect(path[0]).toBe(installed);
    expect(path.filter(inBundle)).toEqual([]);
    expect(launch.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" });
  });

  it("fails when PATH has no git rather than falling back to the bundle", () => {
    expect(() => systemGitLauncher({ PATH: empty }, "installed")).toThrow(
      `PWRGIT_TEST_GIT=installed found no ${name} on PATH.`
    );
  });
});

describe("createSystemGit", () => {
  async function execPaths(): Promise<{ text: string; binary: string }> {
    const text = await createSystemGit()(["--exec-path"], tmpdir());
    const binary = await createSystemGitBinary()(["--exec-path"], tmpdir());
    if (!text.ok) throw new Error(text.error.message);
    if (!binary.ok) throw new Error(binary.error.message);
    return { text: text.value.stdout.trim(), binary: binary.value.stdout.toString().trim() };
  }

  it("runs the bundle by default", async () => {
    vi.stubEnv("PWRGIT_TEST_GIT", "");
    const { text, binary } = await execPaths();
    expect(inBundle(text)).toBe(true);
    expect(binary).toBe(text);
  });

  it("runs the Git the fixtures run under PWRGIT_TEST_GIT=installed", async () => {
    vi.stubEnv("PWRGIT_TEST_GIT", "installed");
    const { text, binary } = await execPaths();
    expect(inBundle(text)).toBe(false);
    expect(text).toBe(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim());
    expect(binary).toBe(text);
  });
});
