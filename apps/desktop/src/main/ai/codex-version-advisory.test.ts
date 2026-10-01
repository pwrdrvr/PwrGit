import { describe, expect, it, vi } from "vitest";
import { buildCodexVersionAdvisory, classifyCodexInstaller, isCodexVersionBelowMinimum } from "./codex-version-advisory";

describe("Codex version advisory", () => {
  it.each([
    ["codex-cli 0.153.4", true],
    ["0.159.0", true],
    ["0.159.1", true],
    ["0.159.2", false],
    ["0.159.2-alpha.2", false],
    ["0.160.0", false],
    ["1.0.0", false],
    ["development", false],
    [undefined, false]
  ])("compares %s against the 0.159.2 baseline", (version, outdated) => {
    expect(isCodexVersionBelowMinimum(version)).toBe(outdated);
  });

  it.each([
    ["/opt/homebrew/Caskroom/codex/0.153.4/codex", "homebrew", "brew upgrade --cask codex"],
    ["/usr/local/Cellar/codex/0.153.4/bin/codex", "homebrew", "brew upgrade codex"],
    ["/home/dev/.bun/install/global/node_modules/@openai/codex/bin/codex.js", "bun", "bun add -g @openai/codex@latest"],
    ["/home/dev/.bun/bin/codex", "bun", "bun add -g @openai/codex@latest"],
    ["/home/dev/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js", "pnpm", "pnpm add -g @openai/codex@latest"],
    [String.raw`C:\Users\dev\AppData\Local\pnpm\codex.cmd`, "pnpm", "pnpm add -g @openai/codex@latest"],
    ["/home/dev/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex.js", "npm", "npm install -g @openai/codex@latest"],
    [String.raw`C:\Users\dev\AppData\Roaming\npm\codex.cmd`, "npm", "npm install -g @openai/codex@latest"],
    ["/Applications/Codex.app/Contents/Resources/codex", "application", undefined],
    ["/opt/custom/codex", "unknown", undefined]
  ])("identifies the installer at %s", (command, installer, upgradeCommand) => {
    expect(classifyCodexInstaller({ command })).toEqual({
      installer, ...(upgradeCommand === undefined ? {} : { upgradeCommand })
    });
  });

  it("follows a symlink to the installer and cleans up the version label", async () => {
    const resolvePath = vi.fn(async () => "/opt/homebrew/Caskroom/codex/0.153.4/codex");
    expect(await buildCodexVersionAdvisory({
      command: "/opt/homebrew/bin/codex", version: "codex-cli 0.153.4", resolvePath
    })).toEqual({
      version: "0.153.4", minimumVersion: "0.159.2", command: "/opt/homebrew/bin/codex",
      installer: "homebrew", upgradeCommand: "brew upgrade --cask codex"
    });
    expect(resolvePath).toHaveBeenCalledWith("/opt/homebrew/bin/codex");
  });

  it("does not inspect the filesystem for a current, unknown, or missing runtime", async () => {
    const resolvePath = vi.fn();
    for (const version of ["0.159.2", "unknown", undefined]) {
      expect(await buildCodexVersionAdvisory({ command: "/bin/codex", version, resolvePath })).toBeUndefined();
    }
    expect(await buildCodexVersionAdvisory({ command: undefined, version: "0.153.4", resolvePath })).toBeUndefined();
    expect(resolvePath).not.toHaveBeenCalled();
  });
});
