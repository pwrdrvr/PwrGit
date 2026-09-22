import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32, type PlatformPath } from "node:path";
import {
  err,
  ok,
  type GitRuntimeCandidate,
  type GitRuntimeProblem,
  type GitRuntimeSource,
  type GitRuntimeStatus,
  type Result
} from "@pwrgit/shared";
import { cliSearchPath } from "../forge/cli-runner";
import type { CommandBus } from "../command-bus";
import { logMain } from "../logs";
import type { SettingsService } from "../settings/settings-service";
import {
  activeGitPath,
  bundledGitPath,
  bundledKeychainHelper,
  gitLaunch,
  installedGitSelection,
  useInstalledGit,
  type GitLaunch
} from "./dugite";

type ProbeResult = { ok: boolean; stdout: string };

/** Everything discovery touches outside this module, so tests can fake a machine. */
export type GitDiscoveryDeps = {
  platform: NodeJS.Platform;
  home: string;
  searchPath: () => string;
  executable: (path: string) => Promise<boolean>;
  realpath: (path: string) => Promise<string | null>;
  /** Apple's selected developer directory (`xcode-select -p`), or null. */
  developerDirectory: () => Promise<string | null>;
  probe: (launch: GitLaunch, args: string[]) => Promise<ProbeResult>;
};

function run(binary: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(binary, args, {
      cwd: tmpdir(), env, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8"
    }, (error, stdout) => resolve({ ok: error === null, stdout: stdout.trim() }));
  });
}

const machine: GitDiscoveryDeps = {
  platform: process.platform,
  home: homedir(),
  searchPath: cliSearchPath,
  executable: async (path) => {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  realpath: async (path) => {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  },
  developerDirectory: async () => {
    const answer = await run("/usr/bin/xcode-select", ["-p"]);
    return answer.ok && answer.stdout !== "" ? answer.stdout : null;
  },
  probe: (launch, args) => run(launch.binary, args, launch.env)
};

const APPLE_GIT_SHIM = "/usr/bin/git";

/** Path rules for the platform discovery is asked about, never the host's:
 *  a Windows PATH splits on `;`, and a test can describe a Mac from any host. */
function pathsFor(deps: GitDiscoveryDeps): PlatformPath {
  return deps.platform === "win32" ? win32 : posix;
}

/**
 * Apple's /usr/bin/git is a shim: with no developer tools it opens their
 * installer, which is not something opening Settings should do. So it is
 * never run. The Git it would forward to is listed instead, and only when
 * that Git is actually there.
 */
async function appleGit(deps: GitDiscoveryDeps): Promise<string | null> {
  const developerDirectory = await deps.developerDirectory();
  if (developerDirectory === null) return null;
  const git = pathsFor(deps).join(developerDirectory, "usr", "bin", "git");
  return (await deps.executable(git)) ? git : null;
}

/** The first `git` on the CLI search path, with Apple's shim swapped for the
 *  Git behind it. */
async function pathGit(deps: GitDiscoveryDeps): Promise<{ path: string; source: GitRuntimeSource } | null> {
  const paths = pathsFor(deps);
  const name = deps.platform === "win32" ? "git.exe" : "git";
  for (const directory of deps.searchPath().split(paths.delimiter)) {
    if (!paths.isAbsolute(directory)) continue;
    const path = paths.join(directory, name);
    if (!(await deps.executable(path))) continue;
    if (deps.platform === "darwin" && (await deps.realpath(path)) === APPLE_GIT_SHIM) {
      const apple = await appleGit(deps);
      // An unusable shim is no answer; keep looking, as a shell would not.
      if (apple === null) continue;
      return { path: apple, source: "xcode" };
    }
    return { path, source: "path" };
  }
  return null;
}

/**
 * Where a Git usually lives, most specific first, so a Homebrew Git found on
 * PATH keeps reading "Homebrew". A path appears once, under its first source.
 */
async function discoveredGits(deps: GitDiscoveryDeps): Promise<Array<{ path: string; source: GitRuntimeSource }>> {
  const { join } = pathsFor(deps);
  const fixed: Array<{ path: string; source: GitRuntimeSource }> =
    deps.platform === "win32"
      ? []
      : [
          ...(deps.platform === "darwin"
            ? [
                { path: "/opt/homebrew/bin/git", source: "homebrew" as const },
                { path: "/usr/local/bin/git", source: "homebrew" as const }
              ]
            : []),
          { path: join(deps.home, ".local", "bin", "git"), source: "user" },
          { path: join(deps.home, "bin", "git"), source: "user" }
        ];
  const found: Array<{ path: string; source: GitRuntimeSource }> = [];
  for (const entry of fixed) {
    if (await deps.executable(entry.path)) found.push(entry);
  }
  if (deps.platform === "darwin") {
    const apple = await appleGit(deps);
    if (apple !== null) found.push({ path: apple, source: "xcode" });
  }
  const onPath = await pathGit(deps);
  if (onPath !== null) found.push(onPath);
  const seen = new Set<string>();
  return found.filter((entry) => !seen.has(entry.path) && seen.add(entry.path));
}

/** Probe one Git the way it would run: its own environment, then LFS through it. */
export async function probeGitRuntime(
  path: string,
  source: GitRuntimeSource,
  deps: GitDiscoveryDeps = machine
): Promise<GitRuntimeCandidate> {
  const bundled = source === "bundled";
  const candidate = (git: string | null, lfs: string | null, problem: GitRuntimeProblem | null): GitRuntimeCandidate =>
    ({ path, source, git, lfs, problem });
  if (!(await deps.executable(path))) return candidate(null, null, "not_found");
  const launch = gitLaunch({}, bundled ? null : path);
  const version = await deps.probe(launch, ["--version"]);
  if (!version.ok || !/^git version \S/.test(version.stdout)) return candidate(null, null, "no_version");
  const lfs = await deps.probe(launch, ["lfs", "version"]);
  return lfs.ok && lfs.stdout.startsWith("git-lfs/")
    ? candidate(version.stdout, lfs.stdout, null)
    : candidate(version.stdout, null, "lfs_missing");
}

export async function readGitRuntimeStatus(deps: GitDiscoveryDeps = machine): Promise<GitRuntimeStatus> {
  const selected = installedGitSelection();
  const discovered = await discoveredGits(deps);
  // A choice discovery would not have found still gets a row, broken or not:
  // the runtime Settings names has to be one it can show.
  const custom = selected !== null && !discovered.some((entry) => entry.path === selected)
    ? [{ path: selected, source: "custom" as const }]
    : [];
  const candidates = await Promise.all([
    probeGitRuntime(bundledGitPath(), "bundled", deps),
    ...[...discovered, ...custom].map((entry) => probeGitRuntime(entry.path, entry.source, deps))
  ]);
  return {
    active: selected === null ? "bundled" : "installed",
    path: activeGitPath(),
    keychainHelper: bundledKeychainHelper(),
    candidates
  };
}

const PROBLEM_MESSAGE: Record<GitRuntimeProblem, (path: string) => string> = {
  not_found: (path) => `There is no executable at ${path}.`,
  no_version: (path) => `${path} did not answer “git --version”, so PwrGit can’t use it as Git.`,
  lfs_missing: (path) =>
    `${path} has no working Git LFS, so repositories that use LFS would check out pointer files. Install Git LFS for it, or keep the bundled Git.`
};

/** Validate, persist and apply a runtime choice. `null` is the bundle. */
export async function selectGitRuntime(
  settings: Pick<SettingsService, "update">,
  requested: string | null,
  deps: GitDiscoveryDeps = machine
): Promise<Result<null>> {
  const path = requested?.trim() ?? "";
  const chosen = path === "" || path === bundledGitPath() ? null : path;
  if (chosen !== null) {
    if (!pathsFor(deps).isAbsolute(chosen)) {
      return err({ kind: "git", code: "git_runtime_relative", message: "Choose Git by its full path." });
    }
    const probed = await probeGitRuntime(chosen, "custom", deps);
    if (probed.problem !== null) {
      return err({ kind: "git", code: `git_runtime_${probed.problem}`, message: PROBLEM_MESSAGE[probed.problem](chosen) });
    }
  }
  settings.update({ gitPath: chosen ?? undefined });
  useInstalledGit(chosen);
  logMain("info", "git", chosen === null ? "repository commands use the bundled Git" : `repository commands use the installed Git at ${chosen}`);
  return ok(null);
}

export function registerGitRuntimeHandlers(bus: CommandBus, settings: Pick<SettingsService, "update">): void {
  // Coalesce StrictMode/concurrent windows without persisting discovery results.
  let pending: Promise<GitRuntimeStatus> | undefined;
  const read = (): Promise<GitRuntimeStatus> => {
    pending ??= readGitRuntimeStatus().finally(() => { pending = undefined; });
    return pending;
  };
  bus.register("git:runtimeStatus", async () => ok(await read()));
  bus.register("git:selectRuntime", async (req) => {
    const selected = await selectGitRuntime(settings, req.path);
    if (!selected.ok) return selected;
    // A read that started before the switch describes the old runtime.
    await pending?.catch(() => undefined);
    return ok(await read());
  });
}
