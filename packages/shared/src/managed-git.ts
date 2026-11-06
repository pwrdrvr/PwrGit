// PwrGit's Git, downloaded: newer builds of the custom huntharo/git runtime
// published between app releases. Settings › Git › PwrGit's Git shows these;
// main (`src/main/git/managed/`) checks, downloads, verifies and installs them.

/** `2.56.0-dev-pwrgit.4`: the only version shape the runtime publishes. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev-pwrgit\.(0|[1-9]\d*)$/;

export type ManagedGitVersion = { major: number; minor: number; patch: number; build: number };

export function parseManagedGitVersion(value: unknown): ManagedGitVersion | null {
  if (typeof value !== "string") return null;
  const match = VERSION.exec(value);
  if (match === null) return null;
  const [major, minor, patch, build] = match.slice(1, 5).map(Number) as [number, number, number, number];
  if (![major, minor, patch, build].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, build };
}

/** Precedence, not publish order: Git's own version first, then the build. */
export function compareManagedGitVersions(left: ManagedGitVersion, right: ManagedGitVersion): number {
  for (const key of ["major", "minor", "patch", "build"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

/**
 * Which builds PwrGit offers, as PwrAgent's managed Codex and grok-build
 * tracks do. `latest`: releases promoted out of testing (GitHub's prerelease
 * flag cleared). `prerelease`: the newest release, promoted or not. Latest is
 * the default: a build published for testing is opted into, never inherited.
 */
export const MANAGED_GIT_TRACKS = ["latest", "prerelease"] as const;
export type ManagedGitTrack = (typeof MANAGED_GIT_TRACKS)[number];
export const MANAGED_GIT_TRACK_DEFAULT: ManagedGitTrack = "latest";

export function isManagedGitTrack(value: unknown): value is ManagedGitTrack {
  return typeof value === "string" && (MANAGED_GIT_TRACKS as readonly string[]).includes(value);
}

/** The install phases, in the order they run. */
export const MANAGED_GIT_INSTALL_PHASES = [
  "downloading",
  "checksum",
  "unpacking",
  "verifying",
  "testing"
] as const;

export type ManagedGitInstallPhase = (typeof MANAGED_GIT_INSTALL_PHASES)[number];

/**
 * What an install reports while it works. `idle` is never held: it clears a
 * finished or cancelled install. Held in memory only, so Settings opened
 * mid-download shows where it is.
 */
export type ManagedGitProgress = {
  phase: "idle" | "checking" | ManagedGitInstallPhase | "ready" | "failed";
  version?: string;
  receivedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  /** `failed`: the reason, and the phase it stopped in. */
  error?: string;
  failedPhase?: ManagedGitInstallPhase | "checking";
  updatedAt: number;
};

/** One verified build on this machine. Its directory never changes once
 *  installed; a new build is a new directory. */
export type ManagedGitBuild = {
  /** `<version>-<first 7 of the source revision>`, also its directory name. */
  id: string;
  version: string;
  sourceRevision: string;
  /** The `git` executable. */
  path: string;
  /** How it was verified: macOS builds by their PwrDrvr Developer ID
   *  signatures, Linux builds by the release's checksums alone. */
  trust: "signed" | "checksum";
  lfsVersion: string | null;
  installedAt: number;
  publishedAt: string | null;
};

/** The newest build the release list offers for this machine. */
export type ManagedGitRelease = {
  version: string;
  tag: string;
  publishedAt: string | null;
  /** Archive bytes, when the release says. */
  size: number | null;
};

export type ManagedGitStatus = {
  /** False where PwrGit offers no build of its own (Windows, other CPUs). */
  supported: boolean;
  /** The build this app ships (`custom-git-runtime.json`). */
  bundledVersion: string;
  /** The track followed (Settings › Git › Build track). */
  track: ManagedGitTrack;
  /** Each track's newest build newer than the bundle, as of the last check;
   *  null when it has none (or no check has answered). Switching tracks
   *  reads this; it never asks GitHub again. */
  tracks: Record<ManagedGitTrack, string | null>;
  /** The followed track's newest release newer than the bundle, or null. */
  latest: ManagedGitRelease | null;
  /** A newer release on the followed track this app cannot verify (it needs
   *  a newer PwrGit). */
  needsAppUpdate: string | null;
  checkedAt: number | null;
  /** Why the last check failed; the last good answer is still shown. */
  checkError: string | null;
  /** Verified builds, newest first. */
  builds: ManagedGitBuild[];
  /** The build chosen in Settings, by id, and the one chosen before it. */
  selected: string | null;
  previous: string | null;
  /** True when the chosen build is what runs (no installed Git chosen over it). */
  inUse: boolean;
  /** The chosen build failed its check at launch, so Git commands refuse. */
  selectedError: string | null;
  progress: ManagedGitProgress | null;
};
