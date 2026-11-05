// Settings › Git: what each card says, as plain functions of the two reads
// (`git:runtimeStatus`, `gitManaged:status`). The nav children and the cards
// they point at render the same answer from here, so a dot can never disagree
// with its card (settings/AGENTS.md).

import {
  MANAGED_GIT_INSTALL_PHASES,
  type GitRuntimeCandidate,
  type GitRuntimeProblem,
  type GitRuntimeSource,
  type GitRuntimeStatus,
  type ManagedGitBuild,
  type ManagedGitInstallPhase,
  type ManagedGitStatus
} from "@pwrgit/shared";
import type { SettingsChipTone } from "./SettingsLayout";
import type { SettingsNavChild, SettingsNavDot } from "./settings-nav";

/** What each row calls where its Git came from. */
export const SOURCE_LABEL: Record<GitRuntimeSource, string> = {
  bundled: "Bundled",
  managed: "PwrGit download",
  path: "PATH",
  homebrew: "Homebrew",
  user: "User",
  xcode: "Apple",
  custom: "Custom"
};

/** The chip a Git that cannot be chosen carries instead of Use. */
export const PROBLEM_LABEL: Record<GitRuntimeProblem, string> = {
  not_found: "Not found",
  no_version: "Didn’t run",
  lfs_missing: "LFS missing",
  failed_check: "Failed check"
};

/** What PwrGit itself proved about a Git. Nothing for a Git it did not
 *  check: an installed Git claims nothing. */
export const TRUST_LABEL: Record<"signed" | "checksum", string> = {
  signed: "Signed by PwrDrvr",
  checksum: "Checksum verified"
};

type Tool = "git" | "lfs";

/**
 * `git --version` and `git lfs version` print sentences, not versions:
 * `git version 2.53.0`, and `git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)`.
 * The row's label already names the tool, so the value is the version alone.
 * The full output is kept beneath it only when it says more than that — LFS's
 * build tail does, `git version 2.53.0` does not. Output in a shape neither
 * pattern knows is shown whole rather than guessed at.
 */
export function describeVersion(
  tool: Tool,
  output: string
): { version: string; detail?: string } {
  const text = output.trim();
  const match = (tool === "git" ? /^git version (\S+)/ : /^git-lfs\/(\S+)/).exec(text);
  const version = match?.[1];
  if (version === undefined) return { version: text };
  const canonical = tool === "git" ? `git version ${version}` : `git-lfs/${version}`;
  return text === canonical ? { version } : { version, detail: text };
}

/** The Git a choice of this row asks `git:selectRuntime` for. */
export function choiceFor(candidate: GitRuntimeCandidate): { path: string | null } | { managed: string } {
  if (candidate.source === "bundled") return { path: null };
  if (candidate.source === "managed" && candidate.managedId !== undefined) return { managed: candidate.managedId };
  return { path: candidate.path };
}

/** The step names an install shows, in the order it runs them. */
export const INSTALL_PHASE_LABEL: Record<ManagedGitInstallPhase, string> = {
  downloading: "Download",
  checksum: "Checksum",
  unpacking: "Unpack",
  verifying: "Files and signatures",
  testing: "Test run"
};

/** What the polite live region says when a phase starts. Phases only, never
 *  byte counts: a sentence per progress tick would drown a screen reader. */
const PHASE_SENTENCE: Record<ManagedGitInstallPhase, string> = {
  downloading: "Downloading",
  checksum: "Checking the checksum",
  unpacking: "Unpacking",
  verifying: "Checking files and signatures",
  testing: "Test-running Git"
};

export type ManagedCardKind =
  /** PwrGit offers no build of its own here (Windows, other CPUs). */
  | "unsupported"
  /** No check has answered yet. */
  | "unchecked"
  | "installing"
  | "failed"
  /** The chosen build failed its check at launch; Git commands refuse. */
  | "launch-failed"
  /** A newer build is published and not downloaded. */
  | "update"
  /** The newest build is downloaded and verified, and not in use. */
  | "ready"
  | "current"
  /** The last check failed and there is nothing newer to offer. */
  | "offline";

export type ManagedCardState = {
  kind: ManagedCardKind;
  /** The card header's chip. Absent while nothing is known. */
  chip?: { label: string; tone: SettingsChipTone };
  /** The nav child's dot and word, from the same answer. */
  dot?: SettingsNavDot;
  word?: string;
  /** Install progress, 0–100, while downloading with a known size. */
  percent?: number;
};

export function isInstallPhase(phase: string | undefined): phase is ManagedGitInstallPhase {
  return (MANAGED_GIT_INSTALL_PHASES as readonly string[]).includes(phase ?? "");
}

/** The build a version refers to, if it is downloaded. */
export function downloadedBuild(managed: ManagedGitStatus, version: string): ManagedGitBuild | undefined {
  return managed.builds.find((build) => build.version === version);
}

/** The managed build that runs, when one does. */
export function managedInUse(managed: ManagedGitStatus): ManagedGitBuild | undefined {
  if (!managed.inUse || managed.selected === null) return undefined;
  return managed.builds.find((build) => build.id === managed.selected);
}

export function installPercent(managed: ManagedGitStatus): number | undefined {
  const progress = managed.progress;
  if (progress?.phase !== "downloading") return undefined;
  const total = progress.totalBytes ?? 0;
  if (total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.floor(((progress.receivedBytes ?? 0) / total) * 100)));
}

/**
 * The card's state. Order is precedence: an install in flight or just failed
 * outranks what the last check said, and a build that failed at launch
 * outranks "up to date", because it is why nothing runs.
 */
export function managedCardState(managed: ManagedGitStatus): ManagedCardState {
  if (!managed.supported) return { kind: "unsupported", chip: { label: "Not offered", tone: "default" } };
  const progress = managed.progress;
  if (progress !== null && (isInstallPhase(progress.phase) || progress.phase === "checking")) {
    const percent = installPercent(managed);
    const label =
      progress.phase === "downloading"
        ? percent === undefined
          ? "Downloading"
          : `Downloading ${percent}%`
        : progress.phase === "checking"
          ? "Starting"
          : PHASE_SENTENCE[progress.phase];
    return {
      kind: "installing",
      chip: { label, tone: "accent" },
      dot: "accent",
      word: percent === undefined ? "busy" : `${percent}%`,
      ...(percent === undefined ? {} : { percent })
    };
  }
  if (progress?.phase === "failed") {
    return { kind: "failed", chip: { label: "Failed", tone: "err" }, dot: "bad", word: "failed" };
  }
  if (managed.selectedError !== null) {
    return { kind: "launch-failed", chip: { label: "Failed check", tone: "err" }, dot: "bad", word: "failed" };
  }
  const latest = managed.latest;
  if (latest !== null) {
    const build = downloadedBuild(managed, latest.version);
    if (build === undefined) {
      return { kind: "update", chip: { label: "Update available", tone: "accent" }, dot: "accent", word: "new" };
    }
    if (managedInUse(managed)?.id !== build.id) {
      return { kind: "ready", chip: { label: "Ready to use", tone: "accent" }, dot: "accent", word: "new" };
    }
  }
  if (managed.checkError !== null) {
    return { kind: "offline", chip: { label: "Couldn’t check", tone: "warn" }, dot: "warn", word: "retry" };
  }
  if (managed.checkedAt === null && latest === null) return { kind: "unchecked" };
  return { kind: "current", chip: { label: "Up to date", tone: "ok" }, dot: "ok" };
}

/** The live region's sentence: changes only when the phase does. */
export function phaseSentence(managed: ManagedGitStatus | null): string {
  const phase = managed?.progress?.phase;
  if (phase === undefined || phase === "idle") return "";
  if (phase === "checking") return "Starting the download";
  if (phase === "ready") return "Ready to use";
  if (phase === "failed") return "Failed. Nothing was installed.";
  return PHASE_SENTENCE[phase];
}

/** The Git PwrGit runs. `path` always names one. */
export function inUseCandidate(status: GitRuntimeStatus): GitRuntimeCandidate | undefined {
  return status.candidates.find((candidate) => candidate.path === status.path);
}

/**
 * The In use card's chip. A Git that cannot run is the state where no
 * repository operation can, so the header must not call it fine. A probe that
 * never answered is a third answer: "we could not look" is not "it is
 * missing". No chip while the first probe is in flight.
 */
export function inUseChip(
  status: GitRuntimeStatus | null,
  failed: boolean
): { label?: string; tone: SettingsChipTone } {
  if (failed) return { label: "Unknown", tone: "warn" };
  if (status === null) return { tone: "default" };
  if (inUseCandidate(status)?.git == null) return { label: "Unavailable", tone: "err" };
  const label = status.active === "bundled" ? "Bundled" : status.active === "managed" ? "PwrGit download" : "Installed";
  return { label, tone: "default" };
}

/**
 * The Git group's nav children. "In use" is green once the Git in use
 * answered and red with a word when it did not; nothing while unprobed.
 * "PwrGit’s Git" carries the managed card's own dot and word.
 */
export function gitNavChildren(
  runtime: GitRuntimeStatus | null,
  runtimeFailed: boolean,
  managed: ManagedGitStatus | null
): SettingsNavChild[] {
  const inUse: SettingsNavChild = { label: "In use", sectionId: "runtime" };
  const chip = inUseChip(runtime, runtimeFailed);
  if (chip.label === "Unavailable") {
    inUse.dot = "bad";
    inUse.chip = "Unavailable";
    inUse.stateLabel = "In use: the Git PwrGit runs isn’t answering";
  } else if (chip.label === "Unknown") {
    inUse.dot = "warn";
    inUse.chip = "Unknown";
    inUse.stateLabel = "In use: Git versions couldn’t be read";
  } else if (chip.label !== undefined) {
    inUse.dot = "ok";
  }
  const own: SettingsNavChild = { label: "PwrGit’s Git", sectionId: "managed" };
  const state = managed === null ? null : managedCardState(managed);
  if (state?.dot !== undefined) {
    own.dot = state.dot;
    if (state.word !== undefined) {
      own.chip = state.word;
      own.stateLabel = `PwrGit’s Git: ${state.chip?.label ?? state.word}`;
    }
  }
  return [inUse, own, { label: "Installs", sectionId: "installs" }];
}

/** `38.9 MB`: decimal megabytes, as the release page counts them. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** `Checked 2 minutes ago`. Minute-grained: a check is a thing the reader
 *  just did, or did not. */
export function checkedAgo(checkedAt: number | null, now: number = Date.now()): string {
  if (checkedAt === null) return "Not checked yet";
  const minutes = Math.floor((now - checkedAt) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Checked yesterday" : `Checked ${days} days ago`;
}
