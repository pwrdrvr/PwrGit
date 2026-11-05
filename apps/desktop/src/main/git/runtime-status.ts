import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32, type PlatformPath } from "node:path";
import {
  err,
  isManagedGitTrack,
  ok,
  type GitReflinkStatus,
  type GitReflinkSupport,
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
  activeGitReflinkProbe,
  bundleLaunch,
  bundledGitPath,
  bundledKeychainHelper,
  gitLaunch,
  holdGitUntil,
  installedGitSelection,
  managedGitDirectory,
  noteGitReflinkSupport,
  reflinkCheckoutActive,
  reflinkCheckoutEnabled,
  shippedBundleDirectory,
  useInstalledGit,
  useManagedGit,
  type GitLaunch
} from "./dugite";
import type { ManagedGitService } from "./managed/managed-git-service";

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

/**
 * Read copy-on-write support from `git worktree -h`. PwrGit's Git lists
 * `[--[no-]reflink]` under `add` (checkout.reflink, runtime .1) and a
 * `git worktree reflink` subcommand (re-share, runtime .2). A usage text is
 * what Git promises to keep stable enough for people; a version string is
 * not, and a local build of the same source carries none.
 */
export function parseReflinkSupport(usage: string): GitReflinkSupport {
  return {
    checkout: usage.includes("[--[no-]reflink]"),
    reshare: /git worktree reflink\b/.test(usage)
  };
}

/**
 * Probe one Git the way it would run: its own environment, then LFS through
 * it. A bundle-shaped Git (`bundle`: the shipped one or a downloaded build)
 * runs as the bundle does, with that directory's helpers and config.
 */
export async function probeGitRuntime(
  path: string,
  source: GitRuntimeSource,
  deps: GitDiscoveryDeps = machine,
  bundle?: string
): Promise<GitRuntimeCandidate> {
  const candidate = (
    git: string | null,
    lfs: string | null,
    problem: GitRuntimeProblem | null,
    reflink?: GitReflinkSupport
  ): GitRuntimeCandidate =>
    ({ path, source, git, lfs, problem, ...(reflink === undefined ? {} : { reflink }) });
  if (!(await deps.executable(path))) return candidate(null, null, "not_found");
  const directory = bundle ?? (source === "bundled" ? shippedBundleDirectory() : undefined);
  const launch = directory !== undefined ? bundleLaunch(directory) : gitLaunch({}, path);
  const version = await deps.probe(launch, ["--version"]);
  if (!version.ok || !/^git version \S/.test(version.stdout)) return candidate(null, null, "no_version");
  const [lfs, usage] = await Promise.all([
    deps.probe(launch, ["lfs", "version"]),
    // Exit status varies by Git (0 or 129); the usage text is the answer.
    deps.probe(launch, ["worktree", "-h"])
  ]);
  // No usage text means the probe never answered (a timeout while main was
  // blocked, say), which is unknown, not "can't": leave it out so the next
  // ask probes again.
  const reflink = /\busage:/.test(usage.stdout) ? parseReflinkSupport(usage.stdout) : undefined;
  return lfs.ok && lfs.stdout.startsWith("git-lfs/")
    ? candidate(version.stdout, lfs.stdout, null, reflink)
    : candidate(version.stdout, null, "lfs_missing", reflink);
}

let managedService: ManagedGitService | null = null;
/** What the bundled row may claim it was verified as (packaged macOS/Linux:
 *  the stager checked it at packaging; elsewhere, nothing). */
let bundledTrust: GitRuntimeCandidate["trust"] | undefined;

/** Set once at startup. */
export function configureManagedGitRuntime(service: ManagedGitService | null, shippedTrust?: GitRuntimeCandidate["trust"]): void {
  managedService = service;
  bundledTrust = shippedTrust;
}

/** Downloaded builds as rows: each verified on disk first, and only then
 *  run. One that fails its check is listed, unchosen and unprobed. */
async function managedCandidates(deps: GitDiscoveryDeps): Promise<GitRuntimeCandidate[]> {
  if (managedService === null) return [];
  const builds = await managedService.verifiedBuilds();
  return Promise.all(
    builds.map(async ({ build, directory }) => {
      const meta = { managedId: build.id, trust: build.trust };
      if (directory === null) {
        return { path: build.path, source: "managed" as const, git: null, lfs: null, problem: "failed_check" as const, ...meta };
      }
      return { ...(await probeGitRuntime(build.path, "managed", deps, directory)), ...meta };
    })
  );
}

function activeKind(): GitRuntimeStatus["active"] {
  if (installedGitSelection() !== null) return "installed";
  return managedGitDirectory() !== null ? "managed" : "bundled";
}

export async function readGitRuntimeStatus(deps: GitDiscoveryDeps = machine): Promise<GitRuntimeStatus> {
  const selected = installedGitSelection();
  const discovered = await discoveredGits(deps);
  // A choice discovery would not have found still gets a row, broken or not:
  // the runtime Settings names has to be one it can show.
  const custom = selected !== null && !discovered.some((entry) => entry.path === selected)
    ? [{ path: selected, source: "custom" as const }]
    : [];
  const [shipped, managed, installed] = await Promise.all([
    probeGitRuntime(bundledGitPath(), "bundled", deps, shippedBundleDirectory()),
    managedCandidates(deps),
    Promise.all([...discovered, ...custom].map((entry) => probeGitRuntime(entry.path, entry.source, deps)))
  ]);
  const candidates = [
    bundledTrust === undefined ? shipped : { ...shipped, trust: bundledTrust },
    ...managed,
    ...installed
  ];
  noteActiveCandidate(candidates);
  return {
    active: activeKind(),
    path: activeGitPath(),
    keychainHelper: bundledKeychainHelper(),
    candidates
  };
}

const NO_REFLINK: GitReflinkSupport = { checkout: false, reshare: false };

/** Keep main's copy-on-write state in step with whatever a probe saw of the
 *  Git in use. A probe that didn't answer records nothing: until one does,
 *  copy-on-write stays off and the next ask probes again. */
function noteActiveCandidate(candidates: GitRuntimeCandidate[]): void {
  const path = activeGitPath();
  const active = candidates.find((candidate) => candidate.path === path);
  if (active?.reflink !== undefined) noteGitReflinkSupport(path, active.git, active.reflink);
}

/** In-flight probes by path: callers asking about the same Git share one,
 *  and a runtime switch never waits on the previous Git's answer. */
const activeProbes = new Map<string, Promise<void>>();

/**
 * Probe only the Git in use, so `checkout.reflink` follows it: at launch
 * and after every runtime switch. Until it answers, copy-on-write checkout
 * stays off — the ordinary writer, never a wrong one.
 */
export function refreshActiveGitReflink(deps: GitDiscoveryDeps = machine): Promise<void> {
  const path = activeGitPath();
  const pending = activeProbes.get(path);
  if (pending !== undefined) return pending;
  const probe = (async () => {
    const installed = installedGitSelection();
    const managed = managedGitDirectory();
    const probed =
      installed !== null
        ? await probeGitRuntime(path, "custom", deps)
        : await probeGitRuntime(path, managed !== null ? "managed" : "bundled", deps, managed ?? shippedBundleDirectory());
    noteActiveCandidate([probed]);
    const support = probed.reflink;
    logMain(
      support === undefined ? "warn" : "info",
      "git",
      support === undefined
        ? `copy-on-write support of ${path}: no answer${probed.problem === null ? "" : ` (${probed.problem})`}, asking again later; flag off`
        : `copy-on-write support of ${path}: checkout ${support.checkout ? "yes" : "no"}, re-share ${support.reshare ? "yes" : "no"}; flag ${reflinkCheckoutActive() ? "on" : "off"}`
    );
  })().finally(() => {
    activeProbes.delete(path);
  });
  activeProbes.set(path, probe);
  return probe;
}

/** What `git:reflinkSupport` answers. */
export async function readGitReflinkStatus(deps: GitDiscoveryDeps = machine): Promise<GitReflinkStatus> {
  if (activeGitReflinkProbe() === null) await refreshActiveGitReflink(deps);
  const probe = activeGitReflinkProbe();
  return {
    path: activeGitPath(),
    version: probe?.version ?? null,
    support: probe?.support ?? NO_REFLINK,
    enabled: reflinkCheckoutEnabled(),
    active: reflinkCheckoutActive()
  };
}

const PROBLEM_MESSAGE: Record<GitRuntimeProblem, (path: string) => string> = {
  not_found: (path) => `There is no executable at ${path}.`,
  no_version: (path) => `${path} did not answer “git --version”, so PwrGit can’t use it as Git.`,
  lfs_missing: (path) =>
    `${path} has no working Git LFS, so repositories that use LFS would check out pointer files. Install Git LFS for it, or keep the bundled Git.`,
  failed_check: (path) => `${path} failed PwrGit’s check of its files and signatures, so PwrGit won’t run it.`
};

type Choice = { kind: "bundled" } | { kind: "installed"; path: string } | { kind: "managed"; id: string };

/**
 * The settings a choice writes. One choice at a time: a downloaded build
 * clears an installed path and the reverse, and the build being left becomes
 * `previous`, the rollback the Git page offers. Precedence when both are
 * somehow stored (a hand-edited file) stays installed > managed > bundled.
 */
export function selectionPatch(
  current: { gitPath?: string | undefined; managedGit?: { selected?: string | undefined; previous?: string | undefined } | undefined },
  choice: Choice
): { gitPath: string | undefined; managedGit: { selected?: string; previous?: string } } {
  const selected = current.managedGit?.selected;
  const chosen = choice.kind === "managed" ? choice.id : undefined;
  // The build being left becomes the rollback; staying on it keeps the old one.
  let previous = selected !== undefined && selected !== chosen ? selected : current.managedGit?.previous;
  if (previous === chosen) previous = undefined;
  const managedGit: { selected?: string; previous?: string } = {
    ...(chosen !== undefined ? { selected: chosen } : {}),
    ...(previous !== undefined ? { previous } : {})
  };
  return { gitPath: choice.kind === "installed" ? choice.path : undefined, managedGit };
}

/** Validate, persist and apply a downloaded build of PwrGit's Git. */
export async function selectManagedGitRuntime(
  settings: Pick<SettingsService, "update" | "get">,
  service: ManagedGitService,
  id: string,
  deps: GitDiscoveryDeps = machine
): Promise<Result<null>> {
  let directory: string;
  try {
    directory = await service.verifyBuild(id);
  } catch (cause) {
    return err({
      kind: "git",
      code: "git_runtime_failed_check",
      message: `PwrGit’s Git ${id} failed its check, so PwrGit won’t run it: ${cause instanceof Error ? cause.message : String(cause)}`
    });
  }
  const path = join(directory, "bin", "git");
  const probed = await probeGitRuntime(path, "managed", deps, directory);
  if (probed.problem !== null) {
    return err({ kind: "git", code: `git_runtime_${probed.problem}`, message: PROBLEM_MESSAGE[probed.problem](path) });
  }
  settings.update(selectionPatch(settings.get(), { kind: "managed", id }));
  useInstalledGit(null);
  useManagedGit(directory);
  service.clearSelectedError();
  holdGitUntil(Promise.resolve());
  noteActiveCandidate([probed]);
  logMain("info", "git", `repository commands use PwrGit’s Git ${id} at ${path}`);
  return ok(null);
}

/** Validate, persist and apply a runtime choice. `null` is the bundle. */
export async function selectGitRuntime(
  settings: Pick<SettingsService, "update"> & Partial<Pick<SettingsService, "get">>,
  requested: string | null,
  deps: GitDiscoveryDeps = machine
): Promise<Result<null>> {
  const path = requested?.trim() ?? "";
  const chosen = path === "" || path === bundledGitPath() ? null : path;
  let probed: GitRuntimeCandidate | null = null;
  if (chosen !== null) {
    if (!pathsFor(deps).isAbsolute(chosen)) {
      return err({ kind: "git", code: "git_runtime_relative", message: "Choose Git by its full path." });
    }
    probed = await probeGitRuntime(chosen, "custom", deps);
    if (probed.problem !== null) {
      return err({ kind: "git", code: `git_runtime_${probed.problem}`, message: PROBLEM_MESSAGE[probed.problem](chosen) });
    }
  }
  settings.update(
    selectionPatch(settings.get?.() ?? {}, chosen === null ? { kind: "bundled" } : { kind: "installed", path: chosen })
  );
  useInstalledGit(chosen);
  useManagedGit(null);
  managedService?.clearSelectedError();
  holdGitUntil(Promise.resolve());
  // The chosen Git was just probed; only the bundle still needs asking.
  if (probed === null) await refreshActiveGitReflink(deps);
  else noteActiveCandidate([probed]);
  logMain("info", "git", chosen === null ? "repository commands use the bundled Git" : `repository commands use the installed Git at ${chosen}`);
  return ok(null);
}

export function registerGitRuntimeHandlers(
  bus: CommandBus,
  settings: Pick<SettingsService, "update" | "get">,
  managed: ManagedGitService | null = managedService
): void {
  // Coalesce StrictMode/concurrent windows without persisting discovery results.
  let pending: Promise<GitRuntimeStatus> | undefined;
  const read = (): Promise<GitRuntimeStatus> => {
    pending ??= readGitRuntimeStatus().finally(() => { pending = undefined; });
    return pending;
  };
  bus.register("git:runtimeStatus", async () => ok(await read()));
  bus.register("git:reflinkSupport", async () => ok(await readGitReflinkStatus()));
  bus.register("git:selectRuntime", async (req) => {
    const selected =
      req.managed !== undefined
        ? managed === null
          ? err({ kind: "git" as const, code: "git_runtime_managed_unsupported", message: "PwrGit offers no build of its Git here." })
          : await selectManagedGitRuntime(settings, managed, req.managed)
        : await selectGitRuntime(settings, req.path);
    if (!selected.ok) return selected;
    // A read that started before the switch describes the old runtime.
    await pending?.catch(() => undefined);
    return ok(await read());
  });
  if (managed !== null) registerManagedGitHandlers(bus, managed, settings);
}

function failure(cause: unknown, code: string): Result<never> {
  return err({ kind: "git", code, message: cause instanceof Error ? cause.message : String(cause) });
}

/** Settings › Git › PwrGit's Git. Main decides when the network is used:
 *  `status` never, `check` only past the cooldown unless forced. */
export function registerManagedGitHandlers(
  bus: CommandBus,
  managed: ManagedGitService,
  settings: Pick<SettingsService, "update">
): void {
  bus.register("gitManaged:status", async () => ok(await managed.status()));
  bus.register("gitManaged:check", async (req) => ok(await managed.check({ force: req.force === true })));
  bus.register("gitManaged:install", async (req) => {
    try {
      return ok(await managed.install(req.version));
    } catch (cause) {
      return failure(cause, "git_managed_install_failed");
    }
  });
  bus.register("gitManaged:cancel", async () => {
    managed.cancel();
    return ok(null);
  });
  // Changes what is offered, never which Git runs: a build in use stays in
  // use on either track.
  bus.register("gitManaged:setTrack", async (req) => {
    if (!isManagedGitTrack(req.track)) {
      return err({ kind: "git", code: "git_managed_track_invalid", message: "Choose the Latest or Prerelease track." });
    }
    settings.update({ managedGitTrack: req.track });
    return ok(await managed.status());
  });
}
