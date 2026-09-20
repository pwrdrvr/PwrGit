import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliSearchPath } from "../forge/cli-runner";
import { installedVersion } from "./runtime-status";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: vi.fn(), realpath: vi.fn() }));
vi.mock("../forge/cli-runner", () => ({ cliSearchPath: vi.fn() }));
vi.mock("./dugite", () => ({ bundledGitPath: vi.fn(), execGit: vi.fn() }));
// Simulate macOS paths on every CI platform.
vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path, join: path.posix.join, delimiter: ":" };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let developerDir: string | null;

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  developerDir = null;
  vi.mocked(cliSearchPath).mockReturnValue("/usr/bin");
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(realpath).mockImplementation(async (path) => String(path));
  vi.mocked(execFile).mockImplementation(((path: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    if (path === "/usr/bin/git" || path === "/alias/git") throw new Error("Apple shim must never run");
    if (path === "/usr/bin/xcode-select") {
      callback(developerDir === null ? new Error("No developer tools") : null, developerDir ?? "");
    } else callback(null, "git version fixture\n");
  }) as typeof execFile);
});
afterEach(() => Object.defineProperty(process, "platform", originalPlatform));

const commands = () => vi.mocked(execFile).mock.calls.map(([path, args]) => [path, args]);

describe("installed Git discovery on macOS", () => {
  it("reports no installed Git without invoking Apple's installation shim", async () => {
    expect(await installedVersion("git")).toBeNull();
    expect(commands()).toEqual([["/usr/bin/xcode-select", ["-p"]]]);
  });

  it.each(["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"])(
    "probes the actual Git under %s when developer tools are available",
    async (directory) => {
      developerDir = directory;
      expect(await installedVersion("git")).toBe("git version fixture");
      expect(commands()).toEqual([
        ["/usr/bin/xcode-select", ["-p"]],
        [`${directory}/usr/bin/git`, ["--version"]]
      ]);
    }
  );

  it("reports no installed Git for a stale developer-tools selection", async () => {
    developerDir = "/removed/Developer";
    vi.mocked(access).mockImplementation(async (path) => {
      if (String(path).startsWith("/removed/")) throw new Error("ENOENT");
    });
    expect(await installedVersion("git")).toBeNull();
    expect(commands()).toEqual([["/usr/bin/xcode-select", ["-p"]]]);
  });

  it("guards a symlink to Apple's shim", async () => {
    vi.mocked(cliSearchPath).mockReturnValue("/alias");
    vi.mocked(realpath).mockResolvedValue("/usr/bin/git");
    expect(await installedVersion("git")).toBeNull();
    expect(commands()).toEqual([["/usr/bin/xcode-select", ["-p"]]]);
  });

  it("continues discovery after an unusable Apple shim", async () => {
    vi.mocked(cliSearchPath).mockReturnValue("/usr/bin:/opt/homebrew/bin");
    expect(await installedVersion("git")).toBe("git version fixture");
    expect(commands()).toEqual([
      ["/usr/bin/xcode-select", ["-p"]],
      ["/opt/homebrew/bin/git", ["--version"]]
    ]);
  });

  it("probes Homebrew Git without requiring developer tools", async () => {
    vi.mocked(cliSearchPath).mockReturnValue("/opt/homebrew/bin:/usr/bin");
    expect(await installedVersion("git")).toBe("git version fixture");
    expect(commands()).toEqual([["/opt/homebrew/bin/git", ["--version"]]]);
  });

  it("does not apply the shim check to Git LFS", async () => {
    expect(await installedVersion("git-lfs")).toBe("git version fixture");
    expect(commands()).toEqual([["/usr/bin/git-lfs", ["--version"]]]);
    expect(realpath).not.toHaveBeenCalled();
  });
});
