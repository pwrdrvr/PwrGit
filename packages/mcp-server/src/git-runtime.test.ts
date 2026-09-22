import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import dugite from "dugite";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledGitEnvironment,
  defaultBundledGitConfigDirectory,
  installedKeychainHelper
} from "./git-runtime.js";

const posix = process.platform !== "win32";
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  // Real paths: macOS /var is a link to /private/var, and helpers are found
  // through the realpath of the Git that ships them.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(directory);
  return directory;
}

/** A Homebrew-shaped install: `<prefix>/bin/git` links into a versioned keg
 *  that carries the helper. Nothing here is ever executed but the helper. */
function homebrewGit(root: string, version: string, helper = true): { bin: string; helper: string } {
  const keg = join(root, "Cellar", "git", version);
  mkdirSync(join(keg, "bin"), { recursive: true });
  writeFileSync(join(keg, "bin", "git"), "");
  const helperPath = join(keg, "libexec", "git-core", "git-credential-osxkeychain");
  if (helper) {
    mkdirSync(dirname(helperPath), { recursive: true });
    // Answers `get` the way the real helper does, from a fixture "keychain".
    writeFileSync(helperPath, "#!/bin/sh\n[ \"$1\" = get ] && printf 'username=fixture-user\\npassword=fixture-secret\\n'\nexit 0\n");
    chmodSync(helperPath, 0o755);
  }
  mkdirSync(join(root, "bin"), { recursive: true });
  const bin = join(root, "bin");
  rmSync(join(bin, "git"), { force: true });
  symlinkSync(join(keg, "bin", "git"), join(bin, "git"));
  return { bin, helper: helperPath };
}

describe.skipIf(!posix)("installedKeychainHelper", () => {
  it("follows PATH to the Git the user runs and takes its keg's helper", () => {
    const root = temporary("pwrgit-brew-");
    const { bin, helper } = homebrewGit(root, "9.1.0");
    expect(installedKeychainHelper({ PATH: bin })).toBe(helper);
  });

  it("skips a Git with no helper and keeps looking down PATH", () => {
    const bare = homebrewGit(temporary("pwrgit-bare-"), "9.0.0", false);
    const { bin, helper } = homebrewGit(temporary("pwrgit-brew-"), "9.1.0");
    expect(installedKeychainHelper({ PATH: [bare.bin, bin].join(delimiter) })).toBe(helper);
  });

  it("finds the upgraded keg once `brew upgrade` removes the cached one", () => {
    const root = temporary("pwrgit-brew-");
    const old = homebrewGit(root, "9.1.0");
    expect(installedKeychainHelper({ PATH: old.bin })).toBe(old.helper);
    rmSync(join(root, "Cellar", "git", "9.1.0"), { recursive: true });
    const upgraded = homebrewGit(root, "9.2.0");
    expect(installedKeychainHelper({ PATH: upgraded.bin })).toBe(upgraded.helper);
  });

  it.skipIf(!existsSync("/usr/bin/git"))(
    "reads Apple's shim through the selected developer directory",
    () => {
      const alias = temporary("pwrgit-alias-");
      symlinkSync("/usr/bin/git", join(alias, "git"));
      const developer = temporary("pwrgit-developer-");
      const helper = join(developer, "usr", "libexec", "git-core", "git-credential-osxkeychain");
      mkdirSync(dirname(helper), { recursive: true });
      writeFileSync(helper, "");
      // Through a symlink too: the shim is recognised by where it resolves.
      expect(installedKeychainHelper({ PATH: alias, DEVELOPER_DIR: developer })).toBe(helper);
    }
  );

  it("finds a Git installed after an earlier search found none", () => {
    const root = temporary("pwrgit-brew-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    expect(installedKeychainHelper({ PATH: bin })).toBeUndefined();
    const installed = homebrewGit(root, "9.1.0");
    expect(installedKeychainHelper({ PATH: bin })).toBe(installed.helper);
  });

  it("finds nothing on a PATH with no Git", () => {
    expect(installedKeychainHelper({ PATH: temporary("pwrgit-empty-") })).toBeUndefined();
  });
});

describe("bundledGitEnvironment", () => {
  it("keeps Dugite's own config when no directory is configured", () => {
    const env = bundledGitEnvironment(undefined, {}, { configDirectory: null });
    expect(env.GIT_CONFIG_SYSTEM).toBeUndefined();
  });

  it("writes the LFS filter ahead of an include of the bundle's config", () => {
    const configDirectory = temporary("pwrgit-gitconfig-");
    const env = bundledGitEnvironment(undefined, {}, { configDirectory, platform: "linux" });
    const file = env.GIT_CONFIG_SYSTEM;
    expect(file).toBeDefined();
    expect(dirname(file ?? "")).toBe(configDirectory);
    const text = readFileSync(file ?? "", "utf8");
    expect(text).toContain("[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n");
    expect(text).not.toContain("[credential]");
    // Defaults first, the bundle's own settings after, so the bundle wins.
    expect(text.indexOf("[include]")).toBeGreaterThan(text.indexOf("[filter \"lfs\"]"));
    // Quoted, with backslashes escaped the way Git's config syntax reads them —
    // which is every separator on Windows.
    const bundleConfig = join(dugite.resolveEmbeddedGitDir(), "etc", "gitconfig");
    expect(text).toContain(`[include]\n\tpath = "${bundleConfig.replaceAll("\\", "\\\\")}"\n`);
  });

  it.skipIf(!posix)("adds the installed keychain helper on macOS, and puts its directory last on PATH", () => {
    const { bin, helper } = homebrewGit(temporary("pwrgit-brew-"), "9.1.0");
    const configDirectory = temporary("pwrgit-gitconfig-");
    const env = bundledGitEnvironment(undefined, { PATH: "/fixture/bin" }, {
      configDirectory, platform: "darwin", searchPath: bin
    });
    const text = readFileSync(env.GIT_CONFIG_SYSTEM ?? "", "utf8");
    expect(text).toContain(`[credential]\n\thelper = "!'${helper}'"\n`);
    const path = (env.PATH ?? "").split(delimiter);
    expect(path.at(-1)).toBe(dirname(helper));
    expect(path).toContain("/fixture/bin");
    expect(path.indexOf("/fixture/bin")).toBeLessThan(path.indexOf(dirname(helper)));
  });

  it("names the file by content, so differing app copies never rewrite each other's", () => {
    const configDirectory = temporary("pwrgit-gitconfig-");
    const one = bundledGitEnvironment(undefined, {}, { configDirectory, platform: "linux" });
    const again = bundledGitEnvironment(undefined, {}, { configDirectory, platform: "linux" });
    const other = bundledGitEnvironment(join(configDirectory, "other-bundle"), {}, { configDirectory, platform: "linux" });
    expect(again.GIT_CONFIG_SYSTEM).toBe(one.GIT_CONFIG_SYSTEM);
    expect(other.GIT_CONFIG_SYSTEM).not.toBe(one.GIT_CONFIG_SYSTEM);
  });

  it("falls back to the bundle's config when the directory cannot be written", () => {
    const blocker = join(temporary("pwrgit-gitconfig-"), "file");
    writeFileSync(blocker, "");
    const env = bundledGitEnvironment(undefined, {}, { configDirectory: join(blocker, "git"), platform: "linux" });
    expect(env.GIT_CONFIG_SYSTEM).toBeUndefined();
  });

  it("lives beside the MCP policy, in PwrGit's own data directory", () => {
    const directory = defaultBundledGitConfigDirectory({ PWRGIT_MCP_POLICY_FILE: "/elsewhere/policy.json" });
    expect(directory.endsWith(join("PwrGit", "git"))).toBe(true);
  });
});

/** The bundled Git itself, reading the generated config: global config
 *  isolated, prompts off, exactly as PwrGit runs it. */
describe.skipIf(!posix)("bundled Git with the generated config", () => {
  function run(args: string[], options: { global?: string; stdin?: string }) {
    const { bin } = homebrewGit(temporary("pwrgit-brew-"), "9.1.0");
    const home = temporary("pwrgit-home-");
    const global = join(home, "gitconfig");
    writeFileSync(global, options.global ?? "");
    return dugite.exec(args, home, {
      env: {
        ...bundledGitEnvironment(undefined, {
          GIT_CONFIG_GLOBAL: global,
          HOME: home,
          GIT_TERMINAL_PROMPT: "0"
        }, { configDirectory: temporary("pwrgit-gitconfig-"), platform: "darwin", searchPath: bin })
      },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin })
    });
  }

  it("signs in to an HTTPS remote through the installed keychain helper", async () => {
    const result = await run(["credential", "fill"], { stdin: "protocol=https\nhost=example.test\n\n" });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("username=fixture-user");
    expect(result.stdout).toContain("password=fixture-secret");
  });

  it("lets a global `credential.helper =` opt out, as it would for an installed Git", async () => {
    const result = await run(["credential", "fill"], {
      global: "[credential]\n\thelper =\n",
      stdin: "protocol=https\nhost=example.test\n\n"
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("fixture-secret");
    expect(result.stderr).toMatch(/terminal prompts disabled/);
  });

  it("turns the LFS filter on, and leaves global config able to override it", async () => {
    const defaults = await run(["config", "--get", "filter.lfs.process"], {});
    expect(defaults.stdout.trim()).toBe("git-lfs filter-process");
    const skipSmudge = await run(["config", "--get", "filter.lfs.smudge"], {
      global: "[filter \"lfs\"]\n\tsmudge = git-lfs smudge --skip -- %f\n"
    });
    expect(skipSmudge.stdout.trim()).toBe("git-lfs smudge --skip -- %f");
  });
});
