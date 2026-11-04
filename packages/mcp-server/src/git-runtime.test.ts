import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import dugite from "dugite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundledGitEnvironment,
  defaultBundledGitConfigDirectory,
  installedKeychainHelper,
  isOwnSystemConfig
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
  // The dev shell's own Git and certificate variables would change every answer.
  const ISOLATED = ["GIT_CONFIG_SYSTEM", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"];
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

  describe("Linux CA fallback", () => {
    const UBUNTU = "/etc/ssl/certs/ca-certificates.crt";
    const RHEL = "/etc/pki/tls/certs/ca-bundle.crt";
    const SUSE = "/etc/ssl/ca-bundle.pem";
    const ALPINE = "/etc/ssl/cert.pem";
    /** A host whose only files are `present`; the runtime ships no CA file. */
    const host = (...present: string[]) => (file: string) => present.includes(file);
    const linux = (exists: (file: string) => boolean, overrides: NodeJS.ProcessEnv = {}) => {
      const env = bundledGitEnvironment(temporary("pwrgit-custom-runtime-"), overrides, {
        configDirectory: temporary("pwrgit-gitconfig-"), platform: "linux", exists
      });
      return { env, text: readFileSync(env.GIT_CONFIG_SYSTEM!, "utf8") };
    };

    it("writes nothing where the runtime libcurl's own default exists", () => {
      const { env, text } = linux(host(UBUNTU, RHEL));
      expect(text).not.toContain("[http]");
      expect(env).not.toHaveProperty("GIT_SSL_CAINFO");
    });

    it("otherwise defaults http.sslCAInfo to the distribution's bundle, below the system config", () => {
      const { env, text } = linux(host(RHEL));
      // Config, never the environment: GIT_SSL_CAINFO would outrank every
      // http.sslCAInfo the machine, user or repository sets.
      expect(env).not.toHaveProperty("GIT_SSL_CAINFO");
      expect(text).toContain(`[http]\n\tsslCAInfo = "${RHEL}"\n`);
      expect(text.indexOf("[http]")).toBeLessThan(text.indexOf("[include]"));
      // In Go crypto/x509's order.
      expect(linux(host(ALPINE, SUSE)).text).toContain(`sslCAInfo = "${SUSE}"`);
      expect(linux(host()).text).not.toContain("[http]");
    });

    it.each(["GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"])(
      "leaves the trust store to a user who set %s",
      (name) => {
        const { env, text } = linux(host(RHEL), { [name]: "/chosen" });
        expect(text).not.toContain("[http]");
        expect(env.GIT_SSL_CAINFO).toBe(name === "GIT_SSL_CAINFO" ? "/chosen" : undefined);
      }
    );

    it("keeps Dugite's own CA file for a bundle that ships one, as Dugite does", () => {
      const runtime = temporary("pwrgit-dugite-runtime-");
      const shipped = join(runtime, "ssl", "cacert.pem");
      const options = { configDirectory: temporary("pwrgit-gitconfig-"), platform: "linux" as const, exists: host(shipped, RHEL) };
      const env = bundledGitEnvironment(runtime, {}, options);
      expect(env.GIT_SSL_CAINFO).toBe(shipped);
      expect(readFileSync(env.GIT_CONFIG_SYSTEM!, "utf8")).not.toContain("[http]");
      expect(bundledGitEnvironment(runtime, { GIT_SSL_CAINFO: "/chosen.pem" }, options).GIT_SSL_CAINFO).toBe("/chosen.pem");
    });

    it("never falls back to the environment, and leaves other platforms alone", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      const unwritten = bundledGitEnvironment(runtime, {}, { configDirectory: null, platform: "linux", exists: host(RHEL) });
      expect(unwritten).not.toHaveProperty("GIT_SSL_CAINFO");
      const mac = bundledGitEnvironment(runtime, {}, {
        configDirectory: temporary("pwrgit-gitconfig-"), platform: "darwin", exists: host(RHEL), searchPath: ""
      });
      expect(mac).not.toHaveProperty("GIT_SSL_CAINFO");
      expect(readFileSync(mac.GIT_CONFIG_SYSTEM!, "utf8")).not.toContain("[http]");
    });

    it.skipIf(!posix)("lets machine, global and repository http.sslCAInfo override the default, in that order", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      // The bundle's config includes a machine-wide file, as Dugite's does with /etc/gitconfig.
      const machine = join(runtime, "machine-gitconfig");
      mkdirSync(join(runtime, "etc"));
      writeFileSync(join(runtime, "etc", "gitconfig"), `[include]\n\tpath = ${machine}\n`);
      const home = temporary("pwrgit-home-");
      const global = join(home, "gitconfig");
      const repo = temporary("pwrgit-repo-");
      const env = bundledGitEnvironment(runtime, { HOME: home, GIT_CONFIG_GLOBAL: global }, {
        configDirectory: temporary("pwrgit-gitconfig-"), platform: "linux", exists: host(RHEL)
      });
      // Only the config files differ; the real bundled binary reads them.
      const git = dugite.resolveGitBinary(dugite.resolveEmbeddedGitDir());
      const read = (cwd: string) => execFileSync(git, ["config", "--get", "http.sslCAInfo"], {
        cwd, encoding: "utf8", env: { HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: env.GIT_CONFIG_SYSTEM }
      }).trim();
      execFileSync(git, ["init", "-q", repo], { env: { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

      writeFileSync(machine, "");
      writeFileSync(global, "");
      expect(read(repo)).toBe(RHEL);
      writeFileSync(machine, "[http]\n\tsslCAInfo = /machine.pem\n");
      expect(read(repo)).toBe("/machine.pem");
      writeFileSync(global, "[http]\n\tsslCAInfo = /global.pem\n");
      expect(read(repo)).toBe("/global.pem");
      execFileSync(git, ["-C", repo, "config", "http.sslCAInfo", "/repo.pem"], { env: { HOME: home, GIT_CONFIG_GLOBAL: global } });
      expect(read(repo)).toBe("/repo.pem");
    });
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

    it("points a stale generated config back at the bundle's when none can be written, and keeps the user's", () => {
      const runtime = temporary("pwrgit-custom-runtime-");
      const stale = join(temporary("pwrgit-gitconfig-"), "gitconfig-old");
      writeFileSync(stale, "# Written by PwrGit: defaults\n");
      const options = { configDirectory: null, platform: "linux" as const };
      expect(bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: stale }, options).GIT_CONFIG_SYSTEM).toBe(bundleConfig(runtime));
      // Returned untouched: Dugite keeps a GIT_CONFIG_SYSTEM it is given.
      expect(bundledGitEnvironment(runtime, { GIT_CONFIG_SYSTEM: "/etc/own" }, options).GIT_CONFIG_SYSTEM).toBe("/etc/own");
    });

    it("treats a missing or empty value as the user's absence, not as PwrGit's", () => {
      expect(isOwnSystemConfig("/bundle", null, undefined)).toBe(false);
      expect(isOwnSystemConfig("/bundle", null, "")).toBe(false);
      expect(isOwnSystemConfig("/bundle", null, join(temporary("pwrgit-etc-"), "absent"))).toBe(false);
      expect(isOwnSystemConfig("/bundle", null, "/bundle/etc/gitconfig")).toBe(true);
      expect(isOwnSystemConfig("/bundle", "/data/git", "/data/git/gitconfig-1")).toBe(true);
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
