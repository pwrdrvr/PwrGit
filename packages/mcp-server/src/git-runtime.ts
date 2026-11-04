import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import dugite from "dugite";
import { defaultMcpPolicyFile } from "./access-policy.js";

export type BundledGitOptions = {
  /**
   * Where the system config generated for the bundle is written. Without one
   * the bundle keeps Dugite's own config, with no LFS filter and no keychain.
   */
  configDirectory?: string | null;
  /** The PATH followed to the installed Git whose keychain helper is reused.
   *  Defaults to the PATH the command inherits. */
  searchPath?: string;
  platform?: NodeJS.Platform;
  /** Whether a file exists. Tests stand in for the host's trust store. */
  exists?: (file: string) => boolean;
};

let defaultConfigDirectory: string | null = null;

/** The standalone server's setting; the desktop passes its own per call. */
export function configureBundledGitConfigDirectory(directory: string | null): void {
  defaultConfigDirectory = directory;
}

/** `<PwrGit app data>/git`: beside the MCP policy file, so the standalone
 *  server and the app it ships with share one generated config. */
export function defaultBundledGitConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultMcpPolicyFile({ ...env, PWRGIT_MCP_POLICY_FILE: "" })), "git");
}

/** Pin Git and its helpers together; inherited Dugite overrides are not a
 * user selection. Keep auth, SSH and certificate configuration intact. */
export function bundledGitEnvironment(
  directory = dugite.resolveEmbeddedGitDir(),
  overrides: NodeJS.ProcessEnv = {},
  options: BundledGitOptions = {}
): NodeJS.ProcessEnv {
  const execPath = dugite.resolveGitExecPath(directory, "");
  const inheritedPath = Object.entries({ ...process.env, ...overrides })
    .reverse().find(([key]) => process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH")?.[1] ?? "";
  const pathEntries = [execPath, dirname(dugite.resolveGitBinary(directory)), inheritedPath];
  const platform = options.platform ?? process.platform;
  const keychainHelper = platform === "darwin"
    ? installedKeychainHelper({
      PATH: options.searchPath ?? inheritedPath,
      DEVELOPER_DIR: overrides.DEVELOPER_DIR ?? process.env.DEVELOPER_DIR
    })
    : undefined;
  // Last, so it only answers names nothing earlier provides: a global
  // `credential.helper = osxkeychain` runs `git-credential-osxkeychain`,
  // which Git looks for in its own exec path and then on PATH.
  if (keychainHelper !== undefined) pathEntries.push(dirname(keychainHelper));
  const configDirectory = options.configDirectory === undefined ? defaultConfigDirectory : options.configDirectory;
  const exists = options.exists ?? existsSync;
  const inherited = { ...process.env, ...overrides };
  // A GIT_CONFIG_SYSTEM that a Pwr app set is rebuilt, never included, so its
  // defaults are not stacked twice. Anything else is the user's own system
  // config, and it is included in place of the bundle's.
  const inheritedSystem = inherited.GIT_CONFIG_SYSTEM || undefined;
  const ownSystem = isOwnSystemConfig(directory, configDirectory, inheritedSystem);
  const bundleSystem = platform === "win32"
    // MinGit reads the config Dugite's build wrote inside the bundle.
    ? mingitSystemConfig(directory, execPath)
    // What Dugite points POSIX Git at.
    : join(directory, "etc", "gitconfig");
  const includedSystem = ownSystem ? bundleSystem : inheritedSystem ?? bundleSystem;
  // Dugite's Linux build ships a CA file, and Dugite points Git at it only
  // when LOCAL_GIT_DIRECTORY is unset, which it never is here.
  const shippedCa = platform === "linux" && exists(join(directory, "ssl", "cacert.pem"))
    ? join(directory, "ssl", "cacert.pem")
    : undefined;
  const systemConfig = configDirectory === null || includedSystem === undefined
    ? undefined
    : bundledSystemConfig(configDirectory, includedSystem, {
      keychainHelper,
      caBundle: platform === "linux" && shippedCa === undefined ? linuxCaBundleFallback(inherited, exists) : undefined
    });
  // With no generated config, Dugite keeps an inherited GIT_CONFIG_SYSTEM, so
  // a stale generated one is pointed back at the bundle's. (On Windows the
  // variable cannot be unset from here; that needs an unwritable data folder.)
  const systemEnv = systemConfig ?? (ownSystem && platform !== "win32" ? bundleSystem : undefined);
  return {
    ...overrides,
    LOCAL_GIT_DIRECTORY: directory,
    GIT_EXEC_PATH: execPath,
    PATH: [...new Set(pathEntries.filter(Boolean))].join(delimiter),
    ...(systemEnv === undefined ? {} : { GIT_CONFIG_SYSTEM: systemEnv }),
    ...(shippedCa === undefined || inherited.GIT_SSL_CAINFO ? {} : { GIT_SSL_CAINFO: shippedCa })
  };
}

/** First line of every system config PwrGit generates. */
const GENERATED_CONFIG_MARKER = "# Written by PwrGit:";
/** The same line from any Pwr app: PwrAgent writes `# Written by PwrAgent:`. */
const PWR_GENERATED_CONFIG = /^# Written by Pwr[A-Za-z]+:/;

/**
 * Whether a GIT_CONFIG_SYSTEM value is one a Pwr app set rather than the
 * user's: the bundle's own file, a config generated in `configDirectory`, or
 * a file whose first line is a Pwr app's generated-config marker. The marker
 * catches a generated file from another data directory, such as a dev profile,
 * or PwrAgent's when PwrGit is launched from a PwrAgent terminal.
 */
export function isOwnSystemConfig(
  bundleRoot: string,
  configDirectory: string | null,
  value: string | undefined
): boolean {
  if (!value) return false;
  const file = resolve(value);
  if (isInside(resolve(bundleRoot), file)) return true;
  if (configDirectory !== null && isInside(resolve(configDirectory), file)) return true;
  try {
    return PWR_GENERATED_CONFIG.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function isInside(directory: string, value: string): boolean {
  const path = relative(directory, value);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * Where Linux distributions keep the system trust store as one PEM file, in
 * the order Go's crypto/x509 searches them. The first is the default compiled
 * into the PwrGit runtime's libcurl (Ubuntu's).
 */
const LINUX_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Arch, Gentoo, current Fedora
  "/etc/pki/tls/certs/ca-bundle.crt", // Fedora, RHEL, Rocky, Alma
  "/etc/ssl/ca-bundle.pem", // openSUSE, SLES
  "/etc/pki/tls/cacert.pem", // OpenELEC
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // CentOS, RHEL 7+
  "/etc/ssl/cert.pem" // Alpine
] as const;

/** Certificate variables a user sets on purpose. Any one of them means the
 * trust store is decided outside Git config. */
const CA_ENVIRONMENT = ["GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"];

/**
 * The distribution's CA bundle, when the runtime libcurl's compiled default
 * is missing, as on openSUSE and the RHEL family.
 *
 * Returned for system-scope `http.sslCAInfo`, never GIT_SSL_CAINFO: the
 * variable would beat global and repository config. At system scope the
 * system config included after it, global and repository config, and any
 * `http.<url>.sslCAInfo` all still win. A user who set a certificate
 * variable gets no fallback.
 */
export function linuxCaBundleFallback(
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync
): string | undefined {
  if (CA_ENVIRONMENT.some((name) => env[name]?.trim())) return undefined;
  const [compiledDefault, ...others] = LINUX_CA_BUNDLES;
  if (exists(compiledDefault)) return undefined;
  return others.find((file) => exists(file));
}

/** Dugite's build writes to etc/gitconfig when MinGit has one there, and to
 * the architecture folder's etc/gitconfig otherwise. */
function mingitSystemConfig(root: string, execPath: string): string | undefined {
  return [
    join(root, "etc", "gitconfig"),
    join(dirname(dirname(execPath)), "etc", "gitconfig")
  ].find((candidate) => existsSync(candidate));
}

const APPLE_GIT_SHIM = "/usr/bin/git";
const KEYCHAIN_HELPER = "git-credential-osxkeychain";
const keychainHelperBySearch = new Map<string, string>();

/**
 * The macOS keychain credential helper that ships with the Git the user
 * already runs, found by following their PATH.
 *
 * Dugite's Git has no credential helper, and its system config only includes
 * /etc/gitconfig. Homebrew's and Apple's Git both set
 * `credential.helper = osxkeychain` in their *own* system config, so without
 * this every HTTPS remote that signed in through the keychain fails under the
 * bundle — and with terminal prompts off there is nothing to fall back on.
 * Reusing the installed binary, rather than shipping one, keeps the keychain
 * items it created readable without a new access prompt.
 */
export function installedKeychainHelper(env: {
  PATH?: string | undefined;
  DEVELOPER_DIR?: string | undefined;
}): string | undefined {
  const searchPath = env.PATH ?? "";
  const key = `${searchPath}\0${env.DEVELOPER_DIR ?? ""}`;
  const cached = keychainHelperBySearch.get(key);
  // The path is versioned (Homebrew's Cellar/git/<version>), and upgrading
  // removes the old keg while the app keeps running. A miss is never cached:
  // Settings tells the user to install a Git, and Re-check has to see it.
  if (cached !== undefined && existsSync(cached)) return cached;
  let found: string | undefined;
  for (const entry of searchPath.split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const git = realpathOrUndefined(join(entry, "git"));
    if (git === undefined) continue;
    // Apple's /usr/bin/git is a shim for the selected developer directory;
    // every other install keeps its helpers in <prefix>/libexec/git-core.
    const gitCore = git === APPLE_GIT_SHIM
      ? join(appleDeveloperDirectory(env.DEVELOPER_DIR), "usr", "libexec", "git-core")
      : join(dirname(dirname(git)), "libexec", "git-core");
    const helper = join(gitCore, KEYCHAIN_HELPER);
    if (existsSync(helper)) {
      found = helper;
      break;
    }
  }
  if (keychainHelperBySearch.size > 32) keychainHelperBySearch.clear();
  if (found === undefined) keychainHelperBySearch.delete(key);
  else keychainHelperBySearch.set(key, found);
  return found;
}

function appleDeveloperDirectory(developerDir: string | undefined): string {
  if (developerDir?.trim()) return developerDir.trim();
  // What `xcode-select -p` reads, without spawning it on every Git launch.
  for (const link of ["/private/var/select/developer_dir", "/var/db/xcode_select_link"]) {
    try {
      return readlinkSync(link);
    } catch {
      // Try the older location, then the Command Line Tools default.
    }
  }
  return "/Library/Developer/CommandLineTools";
}

function realpathOrUndefined(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

const writtenSystemConfigs = new Set<string>();

/**
 * The bundle's system config with the defaults an installed Git and Git LFS
 * would have set at system scope:
 *
 * - The LFS filter, exactly as `git lfs install --system` writes it. Dugite
 *   bundles git-lfs but configures no filter, so without this an LFS
 *   repository checks out pointer files unless the user happened to run
 *   `git lfs install` against their global config. The filter also has
 *   git-lfs install its pre-push hook on first use, so pushes upload objects.
 * - On macOS, the installed keychain credential helper.
 * - On Linux without the runtime libcurl's default CA file, the
 *   distribution's CA bundle as `http.sslCAInfo` (see `linuxCaBundleFallback`).
 *
 * System scope, like the installed Git's, so global and repository config
 * still override every default: `lfs install --skip-smudge` keeps pointers,
 * resetting `credential.helper` opts out, and any `http.sslCAInfo` replaces
 * the CA bundle. The system config Git would otherwise read (the bundle's,
 * which includes /etc/gitconfig, or the user's own GIT_CONFIG_SYSTEM) is
 * included after the defaults so its settings win too.
 *
 * Named by content: app copies that disagree write different files instead
 * of rewriting one another's. Returns undefined when the file cannot be
 * written, leaving the bundle's config in place.
 */
function bundledSystemConfig(
  directory: string,
  systemConfig: string,
  defaults: { keychainHelper?: string | undefined; caBundle?: string | undefined }
): string | undefined {
  const { keychainHelper, caBundle } = defaults;
  const content = [
    `${GENERATED_CONFIG_MARKER} defaults for its bundled Git, then the`,
    "# system config Git would otherwise read. PwrGit rewrites this file, so",
    "# edit your global config (git config --global) instead; it overrides",
    "# everything here.",
    "[filter \"lfs\"]",
    "\tclean = git-lfs clean -- %f",
    "\tsmudge = git-lfs smudge -- %f",
    "\tprocess = git-lfs filter-process",
    "\trequired = true",
    ...(keychainHelper === undefined
      ? []
      : [
        "[credential]",
        // A shell snippet rather than a bare path, so a path with a space
        // (Xcode-beta.app, a renamed volume) still runs as one word.
        `\thelper = ${quoteConfigValue(`!'${keychainHelper.replaceAll("'", "'\\''")}'`)}`
      ]),
    ...(caBundle === undefined ? [] : ["[http]", `\tsslCAInfo = ${quoteConfigValue(caBundle)}`]),
    "[include]",
    `\tpath = ${quoteConfigValue(systemConfig)}`,
    ""
  ].join("\n");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const file = join(directory, `gitconfig-${hash}`);
  if (writtenSystemConfigs.has(file)) return file;
  try {
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
      mkdirSync(directory, { recursive: true });
      // Another process may be reading it: never expose a partial file.
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, content);
      renameSync(temporary, file);
    }
  } catch {
    return undefined;
  }
  writtenSystemConfigs.add(file);
  return file;
}

function quoteConfigValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
