import { join } from "node:path";
import {
  discoverCodexCommands,
  getCodexInstallCandidatePaths
} from "@pwrdrvr/codex-discovery";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedCodexCandidate, toCodexCandidates } from "./ai-provider-discovery";

const fixtures = vi.hoisted(() => ({ versions: new Map<string, string>() }));

// Exercise the published discovery implementation without probing or starting
// any of the operator's installed CLIs. Only these fixture paths exist.
vi.mock("fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: async (command: string) => {
    if (!fixtures.versions.has(command)) {
      throw Object.assign(new Error("fixture not found"), { code: "ENOENT" });
    }
  },
  realpath: async (command: string) => command
}));

vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(vi.fn(), {
    // Match Node's execFile promisification, which returns both output streams.
    [Symbol.for("nodejs.util.promisify.custom")]: async (command: string) => {
      const version = fixtures.versions.get(command);
      if (version === undefined) {
        throw Object.assign(new Error("fixture not found"), { code: "ENOENT" });
      }
      return { stdout: `codex-cli ${version}\n`, stderr: "" };
    }
  })
}));

const HOME = "/fixture/home";
const CHATGPT = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX = "/Applications/Codex.app/Contents/Resources/codex";
const USER_CHATGPT = `${HOME}/Applications/ChatGPT.app/Contents/Resources/codex`;
const USER_CODEX = `${HOME}/Applications/Codex.app/Contents/Resources/codex`;
const HOMEBREW = "/opt/homebrew/bin/codex";
const LOCAL = "/usr/local/bin/codex";
const PINNED = "/fixture/pinned/codex";
const OVERRIDE = "/fixture/override/codex";
const PATH_DIRECTORY = "/fixture/bin";
// The dependency resolves PATH entries with host path joining, even when
// discovery is explicitly targeting macOS on a Windows test runner.
const PATH_CODEX = join(PATH_DIRECTORY, "codex");

function discover(env: NodeJS.ProcessEnv = {}, configuredCommand?: string) {
  return discoverCodexCommands({ platform: "darwin", homeDir: HOME, env, configuredCommand });
}

beforeEach(() => fixtures.versions.clear());

describe("macOS Codex install discovery dependency contract", () => {
  it("keeps both application names, user installs, and Homebrew in their existing order", () => {
    expect(getCodexInstallCandidatePaths("darwin", HOME)).toEqual([
      CHATGPT, CODEX, USER_CHATGPT, USER_CODEX, HOMEBREW, LOCAL
    ]);
  });

  it.each([CHATGPT, USER_CHATGPT, CODEX, USER_CODEX])(
    "discovers %s with the default install paths and exposes it to Settings",
    async (command) => {
      fixtures.versions.set(command, "0.160.0");
      const snapshot = await discover();
      expect(selectedCodexCandidate(snapshot)).toEqual({ command, version: "0.160.0" });
      expect(toCodexCandidates(snapshot)).toEqual([
        { path: command, source: "application", version: "0.160.0", available: true }
      ]);
    }
  );

  it("preserves PATH and install order when versions tie", async () => {
    const commands = [PATH_CODEX, CHATGPT, CODEX, USER_CHATGPT, USER_CODEX, HOMEBREW, LOCAL];
    commands.forEach((command) => fixtures.versions.set(command, "0.160.0"));
    const snapshot = await discover({ PATH: PATH_DIRECTORY });
    expect(snapshot.candidates.map((candidate) => candidate.command)).toEqual(commands);
    expect(selectedCodexCandidate(snapshot)?.command).toBe(PATH_CODEX);
  });

  it.each([CHATGPT, CODEX])("still selects the newer auto candidate: %s", async (newer) => {
    fixtures.versions.set(CHATGPT, newer === CHATGPT ? "0.161.0" : "0.160.0");
    fixtures.versions.set(CODEX, newer === CODEX ? "0.161.0" : "0.160.0");
    expect(selectedCodexCandidate(await discover())?.command).toBe(newer);
  });

  it("keeps configured and environment commands ahead of newer application installs", async () => {
    fixtures.versions.set(CHATGPT, "0.161.0");
    fixtures.versions.set(PINNED, "0.150.0");
    fixtures.versions.set(OVERRIDE, "0.151.0");
    expect(selectedCodexCandidate(await discover({}, PINNED))?.command).toBe(PINNED);
    expect(selectedCodexCandidate(await discover({ PWRDRVR_CODEX_COMMAND: OVERRIDE }, PINNED))?.command)
      .toBe(OVERRIDE);
  });

  it.each(["linux", "win32"] as const)("keeps macOS bundles out of %s discovery", (platform) => {
    expect(getCodexInstallCandidatePaths(platform, HOME).some((command) => /\.app[\\/]/.test(command)))
      .toBe(false);
  });
});
