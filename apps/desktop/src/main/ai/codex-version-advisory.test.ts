import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexVersionAdvisory, classifyCodexInstaller, isCodexVersionBelowMinimum } from "./codex-version-advisory";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
    ["/home/dev/.local/share/pnpm/codex", "pnpm", "pnpm add -g @openai/codex@latest"],
    ["/Users/dev/Library/pnpm/codex", "pnpm", "pnpm add -g @openai/codex@latest"],
    [String.raw`C:\Users\dev\AppData\Local\pnpm\codex.cmd`, "pnpm", "pnpm add -g @openai/codex@latest"],
    ["/home/dev/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex.js", "npm", "npm install -g @openai/codex@latest"],
    ["/usr/local/lib/node_modules/@openai/codex/bin/codex.js", "npm", "npm install -g @openai/codex@latest"],
    ["/home/dev/.npm-global/lib/node_modules/@openai/codex/bin/codex.js", "npm", "npm install -g @openai/codex@latest"],
    [String.raw`C:\Users\dev\AppData\Roaming\npm\codex.cmd`, "npm", "npm install -g @openai/codex@latest"],
    [String.raw`C:\Users\dev\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`, "npm", "npm install -g @openai/codex@latest"],
    [String.raw`C:\Program Files\nodejs\node_modules\@openai\codex\bin\codex.js`, "npm", "npm install -g @openai/codex@latest"],
    ["/home/dev/project/node_modules/@openai/codex/bin/codex.js", "unknown", undefined],
    ["/home/dev/project/node_modules/.pnpm/@openai+codex@0.153.4/node_modules/@openai/codex/bin/codex.js", "unknown", undefined],
    [String.raw`C:\Users\dev\project\node_modules\@openai\codex\bin\codex.js`, "unknown", undefined],
    ["/Applications/Codex.app/Contents/Resources/codex", "application", undefined],
    ["/opt/custom/codex", "unknown", undefined]
  ])("identifies the installer at %s", (command, installer, upgradeCommand) => {
    expect(classifyCodexInstaller({ command })).toEqual({
      installer, ...(upgradeCommand === undefined ? {} : { upgradeCommand })
    });
  });

  it("recognizes a regular extensionless shim in pnpm's Linux global layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwrgit-pnpm-shim-"));
    fixtures.push(root);
    const binDir = join(root, ".local", "share", "pnpm");
    await mkdir(binDir, { recursive: true });
    const command = join(binDir, "codex");
    // pnpm writes a regular shell shim here; realpath does not lead into the
    // global package tree as it does for npm's Unix symlink.
    await writeFile(command, '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/global/5/node_modules/@openai/codex/bin/codex.js" "$@"\n', { mode: 0o755 });
    expect(await buildCodexVersionAdvisory({ command, version: "0.153.4" })).toMatchObject({
      command, installer: "pnpm", upgradeCommand: "pnpm add -g @openai/codex@latest"
    });
  });

  it("does not recommend a global update for a pinned project-local npm symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwrgit-local-codex-"));
    fixtures.push(root);
    const modules = join(root, "project", "node_modules");
    const binDir = join(modules, ".bin");
    const packageBin = join(modules, "@openai", "codex", "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(packageBin, { recursive: true });
    await writeFile(join(packageBin, "codex.js"), "#!/usr/bin/env node\n");
    const command = join(binDir, "codex");
    await symlink("../@openai/codex/bin/codex.js", command, "file");
    const advisory = await buildCodexVersionAdvisory({ command, version: "0.153.4", source: "config" });
    expect(advisory).toMatchObject({ command, installer: "unknown" });
    expect(advisory).not.toHaveProperty("upgradeCommand");
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
