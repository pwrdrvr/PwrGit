import { randomUUID } from "node:crypto";
import type {
  GitTransferProgress,
  ProfileId,
  RemoteActivity,
  RemoteActivityKind,
  RemoteActivityPhase
} from "@pwrgit/shared";
import { sanitizeGitLogDetail } from "./dugite";

/** Lines carried on every live event. Enough to read the last few steps. */
export const REMOTE_ACTIVITY_TAIL_LINES = 8;
/** Lines retained for `remote:activityLog` — the popover's Copy action. */
export const REMOTE_ACTIVITY_LOG_LINES = 300;
/** Output updates are coalesced; a transfer meter repaints many times a second. */
export const REMOTE_ACTIVITY_EMIT_INTERVAL_MS = 400;
/** A meter would otherwise write hundreds of near-identical lines to Logs. */
export const REMOTE_ACTIVITY_METER_LOG_INTERVAL_MS = 5_000;
/**
 * Characters of a Git command line kept for display.
 *
 * Pull's rollback passes a `runBatched` pathspec list that reaches ~32KB. The
 * useful part of "which command is running" is its head — the subcommand and
 * its flags — so keep that and count what was dropped, rather than
 * broadcasting a kilobyte of mid-path text to every window.
 */
export const REMOTE_ACTIVITY_COMMAND_CHARS = 160;

/** `git fetch --prune --progress`, or `git checkout -- … (+812 more)`. */
export function gitCommandLabel(args: string[]): string {
  const kept: string[] = [];
  let length = 3;
  for (const arg of args) {
    if (length + arg.length + 1 > REMOTE_ACTIVITY_COMMAND_CHARS) break;
    kept.push(arg);
    length += arg.length + 1;
  }
  const dropped = args.length - kept.length;
  const head = `git ${kept.join(" ")}`.trimEnd();
  return dropped === 0 ? head : `${head} … (+${dropped} more)`;
}

/**
 * `Receiving objects:  43% (860/2000), 12.4 MiB | 3.1 MiB/s`
 *
 * Deliberately not a fixed list of labels: fetch prints `Receiving objects`,
 * push prints `Writing objects`, and a filter or LFS helper prints its own.
 * Anything shaped like Git's meter is drawn as one.
 */
const TRANSFER_METER =
  /^(?:remote:\s*)?([A-Za-z][A-Za-z0-9 _-]*?):\s+(\d{1,3})%\s+\((\d+)\/(\d+)\)(.*)$/;

const ANSI = /\u001b\[[0-9;]*m/g;

export function parseTransferProgress(line: string): GitTransferProgress | null {
  const match = TRANSFER_METER.exec(line.replace(ANSI, "").trim());
  if (match === null) return null;
  const progress: GitTransferProgress = {
    label: match[1]!,
    percent: Number(match[2]),
    completed: Number(match[3]),
    total: Number(match[4])
  };
  const suffix = match[5] ?? "";
  const bytes = /,\s*([\d.]+\s+(?:bytes?|[KMGTPE]i?B))/i.exec(suffix)?.[1];
  const rate = /\|\s*([^,]+?\/s)(?:,|$)/i.exec(suffix)?.[1];
  if (bytes !== undefined) progress.bytes = bytes;
  if (rate !== undefined) progress.rate = rate.trim();
  return progress;
}

export type RemoteActivityInput = {
  kind: RemoteActivityKind;
  profileId: ProfileId;
  repoId: string;
  repoName: string;
  worktreeId?: string | null;
  branch?: string | null;
  /** The phase the operation reports while it waits for a repository lock. */
  phase?: RemoteActivityPhase;
};

export type RemoteActivityHandle = {
  readonly id: string;
  /**
   * Aborts when the user cancels. Combine it with a watchdog's own signal
   * (`AbortSignal.any`) rather than replacing one with the other — a cancel
   * and a stall are different outcomes and both have to reach Git.
   */
  readonly signal: AbortSignal;
  /** Git stderr sink; wire straight into `GitExecOptions.onStderr`. */
  onStderr: (chunk: string) => void;
  /** Any Git output at all, stdout included; wire into `onActivity`. */
  onActivity: () => void;
  /** The repository lock is held — stop reporting `queued`. */
  setPhase: (phase: RemoteActivityPhase) => void;
  /** The Git command line now running, shown in the popover's footer. */
  setCommand: (args: string[] | null) => void;
  /** The most recent Git line, so a stall warning can name what it last saw. */
  lastLine: () => string | null;
  /** The Git command line now running, for the same warnings. */
  command: () => string | null;
  finish: () => void;
};

type LiveActivity = {
  record: RemoteActivity;
  controller: AbortController;
  log: string[];
  /** Partial line left over from the previous stderr chunk. */
  pending: string;
  /** Meter label whose line currently sits at the end of the buffers. */
  meterLabel: string | null;
  lastMeterLogAt: number;
  /** Retired. A killed Git child can still flush after the handler returns. */
  done: boolean;
};

export type RemoteActivityLogger = (
  level: "debug" | "info" | "warn",
  message: string
) => void;

export type RemoteActivityRegistryOptions = {
  emit: (activities: RemoteActivity[]) => void;
  log?: RemoteActivityLogger;
  now?: () => number;
  emitIntervalMs?: number;
};

/**
 * Every long-running remote Git operation, while it runs.
 *
 * This exists because a spinner is not a status. The registry records what
 * phase an operation reached, when Git last wrote *anything*, and the tail of
 * what it wrote — the three facts that separate "a large transfer is running"
 * from "this has been wedged since it started", which is the case that sent
 * users looking for a log that did not exist.
 *
 * It also owns the cancel: an operation that cannot be stopped leaves closing
 * the app as the only way out.
 */
export class RemoteActivityRegistry {
  private readonly live = new Map<string, LiveActivity>();
  private readonly emit: (activities: RemoteActivity[]) => void;
  private readonly log: RemoteActivityLogger;
  private readonly now: () => number;
  private readonly emitIntervalMs: number;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RemoteActivityRegistryOptions) {
    this.emit = options.emit;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.emitIntervalMs =
      options.emitIntervalMs ?? REMOTE_ACTIVITY_EMIT_INTERVAL_MS;
  }

  begin(input: RemoteActivityInput): RemoteActivityHandle {
    const id = randomUUID();
    const startedAt = this.now();
    const entry: LiveActivity = {
      record: {
        id,
        kind: input.kind,
        phase: input.phase ?? "queued",
        profileId: input.profileId,
        repoId: input.repoId,
        repoName: input.repoName,
        worktreeId: input.worktreeId ?? null,
        branch: input.branch ?? null,
        startedAt,
        phaseSince: startedAt,
        lastOutputAt: startedAt,
        silent: true,
        progress: null,
        command: null,
        tail: [],
        canceling: false
      },
      controller: new AbortController(),
      log: [],
      pending: "",
      meterLabel: null,
      done: false,
      // Never logged, rather than "logged at epoch zero" — a fake or freshly
      // set clock at 0 would otherwise swallow the first sample.
      lastMeterLogAt: Number.NEGATIVE_INFINITY
    };
    this.live.set(id, entry);
    this.publish(true);

    return {
      id,
      signal: entry.controller.signal,
      onStderr: (chunk) => this.ingest(entry, chunk),
      onActivity: () => {
        if (entry.done) return;
        this.noteOutput(entry);
      },
      setPhase: (phase) => {
        if (entry.record.phase === phase) return;
        entry.record.phase = phase;
        entry.record.phaseSince = this.now();
        // A phase change resets the meter: the next one belongs to new work.
        entry.record.progress = null;
        entry.meterLabel = null;
        this.publish(true);
      },
      setCommand: (args) => {
        const command =
          args === null ? null : sanitizeGitLogDetail(gitCommandLabel(args));
        if (entry.record.command === command) return;
        entry.record.command = command;
        // Silence is a property of the command now running, not of the whole
        // operation. A pull runs `rev-parse` before it fetches, and that one
        // line of stdout used to make a fetch that never answered at all read
        // as "no Git output for 5m" instead of "no response" — the same
        // sentence a healthy transfer that merely paused would produce.
        if (command !== null) {
          entry.record.silent = true;
          entry.record.lastOutputAt = this.now();
        }
        this.publish(false);
      },
      lastLine: () => entry.log.at(-1) ?? null,
      command: () => entry.record.command,
      finish: () => {
        if (entry.done) return;
        // Git's last line often has no trailing newline — a `fatal:` as the
        // process dies, or a stream cut mid-line. Without this flush the most
        // diagnostic line of the whole operation is the one line that never
        // reaches the Logs window.
        this.flush(entry);
        entry.done = true;
        this.live.delete(id);
        this.publish(true);
      }
    };
  }

  /** Live operations, newest last. Safe to hand straight to the renderer. */
  list(): RemoteActivity[] {
    return [...this.live.values()].map((entry) => ({
      ...entry.record,
      tail: [...entry.record.tail]
    }));
  }

  /** Everything Git has written for one operation, or null once it is gone. */
  logFor(operationId: string): string[] | null {
    const entry = this.live.get(operationId);
    return entry === undefined ? null : [...entry.log];
  }

  /**
   * Signal Git to stop. The record stays live and flips to `canceling`: Git
   * has to exit, and Pull still has a rollback to run, so removing the row
   * here would take the status away at the moment it is most wanted.
   */
  cancel(operationId: string, message: string): boolean {
    const entry = this.live.get(operationId);
    if (entry === undefined) return false;
    if (entry.record.canceling) return true;
    entry.record.canceling = true;
    this.log("info", `cancel requested for ${entry.record.kind} ${operationId}`);
    entry.controller.abort({
      kind: "remote",
      code: "canceled",
      message
    });
    this.publish(true);
    return true;
  }

  private flush(entry: LiveActivity): void {
    const line = sanitizeGitLogDetail(entry.pending.replace(ANSI, ""));
    entry.pending = "";
    if (line !== "") this.append(entry, line);
  }

  private noteOutput(entry: LiveActivity): void {
    entry.record.lastOutputAt = this.now();
    entry.record.silent = false;
    this.publish(false);
  }

  private ingest(entry: LiveActivity, chunk: string): void {
    if (entry.done) return;
    this.noteOutput(entry);
    // Git separates meter repaints with CR and messages with LF; both are line
    // boundaries here, and whatever trails the last one is an unfinished line.
    const parts = `${entry.pending}${chunk}`.split(/[\r\n]/);
    entry.pending = parts.pop() ?? "";
    for (const part of parts) {
      const line = sanitizeGitLogDetail(part.replace(ANSI, ""));
      if (line === "") continue;
      this.append(entry, line);
    }
  }

  private append(entry: LiveActivity, line: string): void {
    const progress = parseTransferProgress(line);
    if (progress !== null) {
      entry.record.progress = progress;
      // One row per meter, updated in place. Left to accumulate, a single
      // fetch buries every actionable `remote:` message under 100 repaints.
      if (entry.meterLabel === progress.label) {
        entry.record.tail[entry.record.tail.length - 1] = line;
        entry.log[entry.log.length - 1] = line;
        this.logMeter(entry, line);
        this.publish(false);
        return;
      }
      entry.meterLabel = progress.label;
    } else {
      entry.meterLabel = null;
      this.log("info", `${entry.record.repoName}: ${line}`);
    }
    entry.record.tail.push(line);
    if (entry.record.tail.length > REMOTE_ACTIVITY_TAIL_LINES) {
      entry.record.tail.shift();
    }
    entry.log.push(line);
    if (entry.log.length > REMOTE_ACTIVITY_LOG_LINES) entry.log.shift();
    if (progress !== null) this.logMeter(entry, line);
    this.publish(false);
  }

  private logMeter(entry: LiveActivity, line: string): void {
    const at = this.now();
    if (at - entry.lastMeterLogAt < REMOTE_ACTIVITY_METER_LOG_INTERVAL_MS) {
      return;
    }
    entry.lastMeterLogAt = at;
    this.log("debug", `${entry.record.repoName}: ${line}`);
  }

  /**
   * Lifecycle moves go out at once; output updates are coalesced on a trailing
   * timer. A meter repaints faster than any window can paint, and each emit is
   * an IPC message to every window.
   */
  private publish(immediate: boolean): void {
    if (immediate) {
      if (this.emitTimer !== undefined) clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      this.emit(this.list());
      return;
    }
    if (this.emitTimer !== undefined) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit(this.list());
    }, this.emitIntervalMs);
    this.emitTimer.unref?.();
  }
}
