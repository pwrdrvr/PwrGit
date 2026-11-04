import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  /**
   * PwrGit's copy-on-write checkout switch, as `checkout.reflink`. Written
   * after the system config's include, so it outranks the bundle's own config
   * (runtime `.2`'s forced `true`; `.3`, the one PwrGit ships, sets nothing)
   * while global and repository config still win. Undefined writes nothing.
   */
  checkoutReflink?: boolean;
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
  const inherited = { ...process.env, ...overrides };
  // The user's own system config, followed through any config a Pwr app
  // generated around it. It is included in place of the bundle's.
  const inheritedSystem = inherited.GIT_CONFIG_SYSTEM || undefined;
  const userSystem = userSystemConfig(directory, configDirectory, inheritedSystem);
  const bundleSystem = platform === "win32"
    // MinGit reads the config Dugite's build wrote inside the bundle.
    ? mingitSystemConfig(directory, execPath)
    // What Dugite points POSIX Git at.
    : join(directory, "etc", "gitconfig");
  const includedSystem = userSystem ?? bundleSystem;
  const systemConfig = configDirectory === null || includedSystem === undefined
    ? undefined
    : bundledSystemConfig(configDirectory, includedSystem, keychainHelper, options.checkoutReflink);
  // With no generated config, Dugite keeps an inherited GIT_CONFIG_SYSTEM, so
  // it is replaced by the user's own, or by the bundle's when that was an
  // app's. (On Windows the variable cannot be unset from here; that needs an
  // unwritable data folder.)
  const systemEnv = systemConfig
    ?? userSystem
    ?? (inheritedSystem !== undefined && platform !== "win32" ? bundleSystem : undefined);
  return {
    ...overrides,
    LOCAL_GIT_DIRECTORY: directory,
    GIT_EXEC_PATH: execPath,
    PATH: [...new Set(pathEntries.filter(Boolean))].join(delimiter),
    ...(systemEnv === undefined ? {} : { GIT_CONFIG_SYSTEM: systemEnv }),
    // Dugite normally supplies this only when LOCAL_GIT_DIRECTORY is unset.
    ...(process.platform === "linux" && !process.env.GIT_SSL_CAINFO && !overrides.GIT_SSL_CAINFO
      ? { GIT_SSL_CAINFO: join(directory, "ssl", "cacert.pem") } : {})
  };
}

/** First line of every system config PwrGit generates. */
const GENERATED_CONFIG_MARKER = "# Written by PwrGit:";
/** The same line from any Pwr app: PwrAgent writes `# Written by PwrAgent:`. */
const PWR_GENERATED_CONFIG = /^# Written by Pwr[A-Za-z]+:/;

/**
 * The user's own system config that a GIT_CONFIG_SYSTEM value stands for, or
 * undefined when it names none.
 *
 * Apps set the variable too. Dugite points it at a bundled Git's own
 * etc/gitconfig, and PwrGit and PwrAgent point it at a config they generated
 * (in `configDirectory`, or marked by its first line), which includes the
 * system config underneath. PwrAgent's terminal passes its file on, and an
 * environment built from one PwrGit already built carries PwrGit's. A
 * generated config is followed to the file it includes, so the user's config
 * survives however many times it was wrapped. A bundled Git's own config means
 * the user set none. Neither is returned as is, so app defaults and another
 * bundle's config are never stacked beneath ours. PwrAgent's
 * `operatorSystemConfig` follows the same rules.
 */
export function userSystemConfig(
  bundleRoot: string,
  configDirectory: string | null,
  value: string | undefined
): string | undefined {
  let file = value ? resolve(value) : undefined;
  for (let depth = 0; file !== undefined && depth < 8; depth += 1) {
    if (isBundledGitSystemConfig(bundleRoot, file)) return undefined;
    const included = generatedConfigInclude(configDirectory, file);
    if (included === null) return file;
    file = included;
  }
  return undefined;
}

/** Our bundle's files, or another Dugite layout's `git/etc/gitconfig`. */
function isBundledGitSystemConfig(bundleRoot: string, file: string): boolean {
  if (isInside(resolve(bundleRoot), file)) return true;
  const gitDirectory = dirname(dirname(file));
  return basename(file) === "gitconfig"
    && basename(dirname(file)) === "etc"
    && basename(gitDirectory) === "git"
    && existsSync(join(gitDirectory, "libexec", "git-core"));
}

/**
 * For a config a Pwr app generated, the system config it includes, or
 * undefined when it includes none. Null for any other file.
 */
function generatedConfigInclude(configDirectory: string | null, file: string): string | undefined | null {
  const ours = configDirectory !== null && isInside(resolve(configDirectory), file);
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return ours ? undefined : null;
  }
  if (!ours && !PWR_GENERATED_CONFIG.test(content)) return null;
  const include = content.lastIndexOf("[include]");
  if (include < 0) return undefined;
  const value = /^\s*path\s*=\s*(.*?)\s*$/m.exec(content.slice(include))?.[1];
  return value ? resolve(dirname(file), unquoteConfigValue(value)) : undefined;
}

function isInside(directory: string, value: string): boolean {
  const path = relative(directory, value);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
 * - After the include, `checkout.reflink` when the app passes its switch:
 *   the one setting PwrGit means to hold over the bundle's own.
 *
 * System scope, like the installed Git's, so global and repository config
 * still override every default: `lfs install --skip-smudge` keeps pointers,
 * and resetting `credential.helper` opts out. The system config Git would
 * otherwise read (the bundle's, which includes /etc/gitconfig, or the user's
 * own GIT_CONFIG_SYSTEM) is included after the defaults so its settings win
 * too.
 *
 * Named by content: app copies that disagree write different files instead
 * of rewriting one another's. Returns undefined when the file cannot be
 * written, leaving the bundle's config in place.
 */
function bundledSystemConfig(
  directory: string,
  systemConfig: string,
  keychainHelper: string | undefined,
  checkoutReflink: boolean | undefined
): string | undefined {
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
    "[include]",
    `\tpath = ${quoteConfigValue(systemConfig)}`,
    ...(checkoutReflink === undefined ? [] : ["[checkout]", `\treflink = ${checkoutReflink}`]),
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

function unquoteConfigValue(value: string): string {
  if (value.length < 2 || !value.startsWith("\"") || !value.endsWith("\"")) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

function quoteConfigValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
