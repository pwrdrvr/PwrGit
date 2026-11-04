import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import dugite from "dugite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundledGitEnvironment,
  defaultBundledGitConfigDirectory,
  installedKeychainHelper,
  userSystemConfig
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
  const link = join(bin, "git");
  // rmSync(force) leaves a dangling symlink behind on Node 24.
  if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
  symlinkSync(join(keg, "bin", "git"), link);
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
  // The dev shell's own system config would change every answer.
  const ISOLATED = ["GIT_CONFIG_SYSTEM"];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of ISOLATED) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

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

  describe("an inherited GIT_CONFIG_SYSTEM", () => {
    // Unquoted: Git's config syntax escapes every backslash, as on Windows.
    const includeOf = (file: string) =>
      readFileSync(file, "utf8").match(/\[include\]\n\tpath = "(.*)"/)?.[1]?.replaceAll("\\\\", "\\");
    const bundleConfig = (runtime: string) => join(runtime, "etc", "gitconfig");

    it("includes the user's own system config in place of the bundle's", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      const own = join(temporary("pwrgit-etc-"), "gitconfig");
      writeFileSync(own, "[user]\n\tname = Machine\n");
      const configDirectory = temporary("pwrgit-gitconfig-");
      const env = bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: own }, { configDirectory, platform: "linux" });
      expect(dirname(env.GIT_CONFIG_SYSTEM!)).toBe(configDirectory);
      expect(includeOf(env.GIT_CONFIG_SYSTEM!)).toBe(own);
      // From the process environment too, which is how Dugite and the app see it.
      process.env.GIT_CONFIG_SYSTEM = own;
      expect(includeOf(bundledGitEnvironment(runtime, {}, { configDirectory, platform: "linux" }).GIT_CONFIG_SYSTEM!)).toBe(own);
    });

    it("rebuilds a Pwr app's generated config, or the bundle's, instead of stacking it", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      const configDirectory = temporary("pwrgit-gitconfig-");
      const elsewhere = temporary("pwrgit-other-profile-");
      // PwrAgent's terminal hands its generated file to anything launched there.
      const pwragent = join(elsewhere, "pwragent-gitconfig");
      writeFileSync(pwragent, "# Written by PwrAgent: defaults for its bundled Git\n[filter \"lfs\"]\n");
      const first = bundledGitEnvironment(runtime, {}, { configDirectory, platform: "linux" }).GIT_CONFIG_SYSTEM!;
      const devProfile = join(elsewhere, "gitconfig-dev");
      writeFileSync(devProfile, readFileSync(first, "utf8"));
      for (const inherited of [first, devProfile, pwragent, bundleConfig(runtime)]) {
        const env = bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: inherited }, { configDirectory, platform: "linux" });
        expect(env.GIT_CONFIG_SYSTEM).toBe(first);
        expect(includeOf(env.GIT_CONFIG_SYSTEM!)).toBe(bundleConfig(runtime));
      }
    });

    it("keeps the user's config through every rebuild and through PwrAgent's wrapper", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      const configDirectory = temporary("pwrgit-gitconfig-");
      const options = { configDirectory, platform: "linux" as const };
      const etc = temporary("pwrgit-etc-");
      const own = join(etc, "gitconfig");
      writeFileSync(own, "[user]\n\tname = Machine\n");
      // A PwrGit terminal passes its generated file on; building again from
      // that environment must still reach the user's file.
      let env: NodeJS.ProcessEnv = { GIT_CONFIG_SYSTEM: own };
      for (let build = 0; build < 3; build += 1) {
        env = bundledGitEnvironment(runtime, env, options);
        expect(includeOf(env.GIT_CONFIG_SYSTEM!)).toBe(own);
      }
      // PwrAgent's generated file, written the same way, with escapes.
      const pwragent = join(temporary("pwragent-gitconfig-"), "gitconfig-abc");
      const quoted = own.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
      writeFileSync(pwragent, `# Written by PwrAgent: defaults\n[credential]\n\thelper = x\n[include]\n\tpath = "${quoted}"\n`);
      expect(includeOf(bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: pwragent }, options).GIT_CONFIG_SYSTEM!)).toBe(own);
      // A relative include resolves against the generated file's directory.
      const relativeWrapper = join(etc, "wrapper");
      writeFileSync(relativeWrapper, "# Written by PwrAgent: defaults\n[include]\n\tpath = gitconfig\n");
      expect(userSystemConfig(runtime, configDirectory, relativeWrapper)).toBe(own);
    });

    it("treats a bundled Git's own config as no user config, wherever the bundle is", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      const configDirectory = temporary("pwrgit-gitconfig-");
      // Another Pwr app's bundle, which PwrAgent's generated file includes.
      const other = join(temporary("pwragent-app-"), "git");
      mkdirSync(join(other, "libexec", "git-core"), { recursive: true });
      mkdirSync(join(other, "etc"));
      writeFileSync(join(other, "etc", "gitconfig"), "[pwrtest]\n\talpha = other-bundle\n");
      const wrapper = join(temporary("pwragent-gitconfig-"), "gitconfig-abc");
      writeFileSync(wrapper, `# Written by PwrAgent: defaults\n[include]\n\tpath = "${join(other, "etc", "gitconfig").replaceAll("\\", "\\\\")}"\n`);
      // A generated file that includes itself ends at the depth limit.
      const loop = join(temporary("pwrgit-loop-"), "gitconfig-loop");
      writeFileSync(loop, `# Written by PwrGit: defaults\n[include]\n\tpath = "${loop.replaceAll("\\", "\\\\")}"\n`);
      for (const inherited of [join(other, "etc", "gitconfig"), wrapper, loop]) {
        expect(userSystemConfig(runtime, configDirectory, inherited)).toBeUndefined();
        const env = bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: inherited }, { configDirectory, platform: "linux" });
        expect(includeOf(env.GIT_CONFIG_SYSTEM!)).toBe(bundleConfig(runtime));
      }
    });

    it("hands Dugite the user's config, or the bundle's, when no generated config can be written", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      const own = join(temporary("pwrgit-etc-"), "gitconfig");
      writeFileSync(own, "");
      const wrapped = join(temporary("pwragent-gitconfig-"), "gitconfig-abc");
      writeFileSync(wrapped, `# Written by PwrAgent: defaults\n[include]\n\tpath = "${own.replaceAll("\\", "\\\\")}"\n`);
      const stale = join(temporary("pwrgit-gitconfig-"), "gitconfig-old");
      writeFileSync(stale, "# Written by PwrGit: defaults\n");
      const options = { configDirectory: null, platform: "linux" as const };
      // Dugite keeps a GIT_CONFIG_SYSTEM it is given, so ours must be final.
      expect(bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: wrapped }, options).GIT_CONFIG_SYSTEM).toBe(own);
      expect(bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: stale }, options).GIT_CONFIG_SYSTEM).toBe(bundleConfig(runtime));
      expect(bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: "/etc/own" }, options).GIT_CONFIG_SYSTEM).toBe(resolve("/etc/own"));
      expect(bundledGitEnvironment(runtime, {}, options)).not.toHaveProperty("GIT_CONFIG_SYSTEM");
    });

    it("treats a missing or empty value as no user config, and any other file as the user's", () => {
      expect(userSystemConfig("/bundle", null, undefined)).toBeUndefined();
      expect(userSystemConfig("/bundle", null, "")).toBeUndefined();
      const absent = join(temporary("pwrgit-etc-"), "absent");
      expect(userSystemConfig("/bundle", null, absent)).toBe(absent);
      expect(userSystemConfig("/bundle", null, "/bundle/etc/gitconfig")).toBeUndefined();
      expect(userSystemConfig("/bundle", "/data/git", "/data/git/gitconfig-1")).toBeUndefined();
    });
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
