import type { PullProgressPhase, PwrGitError } from "@pwrgit/shared";

// Fetch/merge are forced to emit progress. Two minutes catches a suspicious
// pause early; fifteen output-free minutes and sixty total minutes leave ample
// room for large transfers while bounding a truly wedged filter/helper.
export const PULL_STALL_WARNING_MS = 2 * 60_000;
export const PULL_STALL_TIMEOUT_MS = 15 * 60_000;
export const PULL_OPERATION_TIMEOUT_MS = 60 * 60_000;
export const PULL_RECOVERY_STALL_WARNING_MS = 60_000;
export const PULL_RECOVERY_STALL_TIMEOUT_MS = 5 * 60_000;
export const PULL_RECOVERY_OPERATION_TIMEOUT_MS = 10 * 60_000;

export type PullWatchdogPhase = PullProgressPhase | "starting" | "recovery";

export type PullWatchdogSnapshot = {
  phase: PullWatchdogPhase;
  elapsedMs: number;
  idleMs: number;
};

export type PullWatchdogOptions = {
  stallWarningMs?: number;
  stallTimeoutMs?: number;
  operationTimeoutMs?: number;
  onStallWarning?: (snapshot: PullWatchdogSnapshot) => void;
  onTimeout?: (error: PwrGitError, snapshot: PullWatchdogSnapshot) => void;
};

export function pullPhaseDescription(phase: PullWatchdogPhase): string {
  switch (phase) {
    case "starting":
      return "starting";
    case "fetch":
      return "fetching";
    case "prepare":
      return "inspecting/preparing local changes";
    case "fast_forward":
      return "fast-forward/checkout";
    case "reapply":
      return "reapplying local changes";
    case "refresh":
      return "refreshing/finish";
    case "recovery":
      return "rollback/recovery";
  }
}

export function formatPullDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** Pull-scoped watchdog. Phase changes and Git output both count as progress. */
export class PullWatchdog {
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private readonly stallWarningMs: number;
  private readonly stallTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private warningTimer: ReturnType<typeof setTimeout> | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private operationTimer: ReturnType<typeof setTimeout> | undefined;
  private currentPhase: PullWatchdogPhase = "starting";
  private lastActivityAt = this.startedAt;
  private stopped = false;

  constructor(private readonly options: PullWatchdogOptions = {}) {
    this.stallWarningMs = options.stallWarningMs ?? PULL_STALL_WARNING_MS;
    this.stallTimeoutMs = options.stallTimeoutMs ?? PULL_STALL_TIMEOUT_MS;
    this.operationTimeoutMs =
      options.operationTimeoutMs ?? PULL_OPERATION_TIMEOUT_MS;
    this.armIdleTimers();
    this.operationTimer = setTimeout(
      () => this.timeout("pull_timed_out"),
      this.operationTimeoutMs
    );
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get phase(): PullWatchdogPhase {
    return this.currentPhase;
  }

  setPhase(phase: PullWatchdogPhase): void {
    if (this.stopped) return;
    this.currentPhase = phase;
    this.noteActivity();
  }

  noteActivity(): void {
    if (this.stopped) return;
    this.lastActivityAt = Date.now();
    this.armIdleTimers();
  }

  finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
  }

  private snapshot(): PullWatchdogSnapshot {
    const now = Date.now();
    return {
      phase: this.currentPhase,
      elapsedMs: now - this.startedAt,
      idleMs: now - this.lastActivityAt
    };
  }

  private armIdleTimers(): void {
    if (this.warningTimer !== undefined) clearTimeout(this.warningTimer);
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.warningTimer = setTimeout(() => this.warnAndRearm(), this.stallWarningMs);
    this.stallTimer = setTimeout(
      () => this.timeout("pull_stalled"),
      this.stallTimeoutMs
    );
  }

  private warnAndRearm(): void {
    if (this.stopped) return;
    this.options.onStallWarning?.(this.snapshot());
    this.warningTimer = setTimeout(() => this.warnAndRearm(), this.stallWarningMs);
  }

  private timeout(code: "pull_stalled" | "pull_timed_out"): void {
    if (this.stopped) return;
    const snapshot = this.snapshot();
    const phase = pullPhaseDescription(snapshot.phase);
    const elapsed = formatPullDuration(snapshot.elapsedMs);
    const idle = formatPullDuration(snapshot.idleMs);
    const error: PwrGitError = {
      kind: "remote",
      code,
      message:
        code === "pull_stalled"
          ? `PwrGit stopped the Git process during ${phase} after ${elapsed} because it produced no output for ${idle}. Check the network, credentials, and Git LFS, then retry. See Logs for details.`
          : `PwrGit stopped the Git process during ${phase} after ${elapsed} because Pull exceeded the ${formatPullDuration(this.operationTimeoutMs)} operation limit. Check the network and Git LFS, then retry. See Logs for details.`,
      cause: snapshot
    };
    this.stopped = true;
    this.clearTimers();
    this.options.onTimeout?.(error, snapshot);
    this.controller.abort(error);
  }

  private clearTimers(): void {
    if (this.warningTimer !== undefined) clearTimeout(this.warningTimer);
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    if (this.operationTimer !== undefined) clearTimeout(this.operationTimer);
    this.warningTimer = undefined;
    this.stallTimer = undefined;
    this.operationTimer = undefined;
  }
}
