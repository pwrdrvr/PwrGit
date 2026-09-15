import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { errorMonitor } from "node:events";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";

type Event = { atMs: number; event: string; code?: number | null | undefined; signal?: string | null | undefined };
type StreamName = "stdout" | "stderr";
export type GitDiagnosticReport = Record<string, unknown>;
export type GitDiagnosticScope = {
  /** Only install for small, local test fixtures with an expected duration. */
  thresholdMs: number;
  /** Selected known-fast commands can report earlier within a fixture scope. */
  commandThresholdsMs?: Readonly<Record<string, number>>;
  /** Persist completion/close timelines even when these calls stay below threshold. */
  retainCommands?: readonly string[];
  emit: (report: GitDiagnosticReport) => void;
  processSample?: boolean;
  /** Compact call boundaries. Test sinks persist these before blocking work. */
  record?: (report: GitDiagnosticReport) => void;
};

export type GitDiagnosticStage = "test" | "setup" | "operation" | "verification" | "cleanup";
type Accounting = { started: number; completed: number; rejected: number; sumMs: number; maxMs: number };
const emptyAccounting = (): Accounting => ({ started: 0, completed: 0, rejected: 0, sumMs: 0, maxMs: 0 });
let accounting = emptyAccounting();
let bySource: Record<string, Accounting> = {};
let byCommand: Record<string, Accounting> = {};
let stage: GitDiagnosticStage = "test";
let stageStarted = performance.now();
let stages: Partial<Record<GitDiagnosticStage, Accounting & { wallMs: number }>> = {};

function stageAccounting(name: GitDiagnosticStage) {
  return stages[name] ??= { ...emptyAccounting(), wallMs: 0 };
}

export function markGitDiagnosticStage(next: GitDiagnosticStage): void {
  if (!scope) return;
  stageAccounting(stage).wallMs += performance.now() - stageStarted;
  stage = next;
  stageStarted = performance.now();
  stageAccounting(stage);
  record({ event: "stage", stage, monotonicMs: monotonicMs(), aggregate: { ...accounting } });
}

function monotonicMs(): number { return Number(process.hrtime.bigint()) / 1e6; }
function record(report: GitDiagnosticReport): void {
  try { scope?.record?.(report); } catch { /* Diagnostics never replace a result. */ }
}

let scope: GitDiagnosticScope | undefined;
const active = new Set<GitDiagnostic>();
const recent: GitDiagnosticReport[] = [];
let sequence = 0;

/** Test-only opt-in. Production pays no timer/listener cost by default. */
export function configureGitDiagnostics(value: GitDiagnosticScope | undefined): void {
  for (const diagnostic of active) diagnostic.dispose("scope-ended");
  active.clear();
  recent.length = 0;
  scope = value;
  accounting = emptyAccounting();
  bySource = {};
  byCommand = {};
  stages = {};
  stage = "test";
  stageStarted = performance.now();
}

export function gitDiagnosticContext(): GitDiagnosticReport {
  const stageTotals = Object.fromEntries(Object.entries(stages).map(([name, totals]) =>
    [name, { ...totals, wallMs: totals.wallMs + (name === stage ? performance.now() - stageStarted : 0) }]));
  return { active: [...active].map((item) => item.snapshot()), recent: [...recent],
    aggregate: { ...accounting }, bySource: structuredClone(bySource),
    byCommand: structuredClone(byCommand), stage, stages: stageTotals,
    accountingScope: "instrumented calls only; sumMs adds durations and can overlap for concurrent calls" };
}

// Never retain arguments, URLs, config values, ref/file names, output, or env.
// A hash correlates repository paths without disclosing usernames or repo names.
const commands = new Set("add apply branch cat-file checkout cherry-pick clean clone commit config diff fetch for-each-ref init log ls-files ls-tree merge merge-base mv pull push range-diff rebase reflog remote reset restore rev-list rev-parse rm show show-ref stash status submodule switch symbolic-ref tag update-index update-ref version worktree".split(" "));
export function safeGitIdentity(args: string[], cwd: string): GitDiagnosticReport {
  let index = 0;
  while (index < args.length && args[index]?.startsWith("-")) {
    const option = args[index++];
    if (option === "-C" || option === "-c" || option === "--git-dir" || option === "--work-tree") index++;
  }
  return {
    command: commands.has(args[index] ?? "") ? args[index] : "other",
    argumentCount: args.length,
    cwdId: createHash("sha256").update(cwd).digest("hex").slice(0, 12),
    nativeCwd: "os.tmpdir"
  };
}

function streamState(stream: Readable | Writable | null | undefined): unknown {
  if (!stream) return null;
  return {
    destroyed: stream.destroyed,
    closed: stream.closed,
    ...( "readable" in stream ? {
      readable: stream.readable, readableEnded: stream.readableEnded,
      readableFlowing: stream.readableFlowing, readableLength: stream.readableLength
    } : {}),
    ...( "writable" in stream ? {
      writable: stream.writable, writableEnded: stream.writableEnded,
      writableFinished: stream.writableFinished, writableLength: stream.writableLength
    } : {})
  };
}

/** Numeric OS process relationships only; never command lines or environment.
 * Reparented descendants cannot reliably be attributed after the parent exits.
 * Killing this bounded sampler on timeout never targets the observed process. */
function sampleProcesses(pid: number | undefined, emit: (report: GitDiagnosticReport) => void): () => void {
  const windows = process.platform === "win32";
  const file = windows ? "powershell.exe" : "ps";
  const args = windows
    ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation"]
    : ["-e", "-o", "pid=,ppid=,stat="];
  const started = performance.now();
  let canceled = false;
  const sampler = execFile(file, args, { timeout: 1500, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
    if (canceled) return;
    const rows = stdout.split(/\r?\n/).flatMap((line) => {
      const match = windows ? /^"(\d+)","(\d+)"$/.exec(line.trim()) : /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>NsElWX-]+)\s*$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), state: match[3] }] : [];
    });
    const wanted = new Set([process.pid, pid]);
    for (let depth = 0; depth < 8; depth++) {
      for (const row of rows) if (wanted.has(row.ppid) && wanted.size < 64) wanted.add(row.pid);
    }
    emit({ event: "os-process-sample", elapsedMs: performance.now() - started,
      status: error ? "unavailable-or-incomplete" : "sampled", platform: process.platform,
      processes: rows.filter((row) => wanted.has(row.pid)).slice(0, 64),
      limitation: "Point-in-time ancestry; an exited parent or reparented pipe holder may be absent." });
  });
  sampler.unref();
  return () => { canceled = true; sampler.kill(); };
}

export class GitDiagnostic {
  private readonly started = performance.now();
  readonly id = `${process.pid}-${++sequence}`;
  private readonly events: Event[] = [];
  private readonly bytes = { stdout: 0, stderr: 0 };
  private readonly lastActivityMs: Record<StreamName, number | null> = { stdout: null, stderr: null };
  private readonly removers: (() => void)[] = [];
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private cancelSample?: () => void;
  private slow = false;
  private settled = false;
  private closed = false;
  private disposed = false;
  private timerLatenessMs: number | null = null;
  private readonly callStage = stage;
  private readonly callAccounting: Accounting[];
  private readonly sync: boolean;

  constructor(private readonly settings: GitDiagnosticScope, private readonly identity: GitDiagnosticReport) {
    this.sync = identity.source === "system-git-sync";
    const source = String(identity.source);
    const command = String(identity.command);
    this.callAccounting = [accounting, bySource[source] ??= emptyAccounting(),
      byCommand[command] ??= emptyAccounting(), stageAccounting(this.callStage)];
    for (const totals of this.callAccounting) totals.started++;
    active.add(this);
    this.event("invocation");
    this.recordBoundary("call-begin");
    if (this.sync) return; // A same-thread timer cannot inspect execFileSync.
    this.timer = setTimeout(() => {
      this.timerLatenessMs = Math.max(0, this.elapsed() - settings.thresholdMs);
      this.slow = true;
      this.report("slow-trigger");
      if (settings.processSample !== false) {
        this.cancelSample = sampleProcesses(this.child?.pid, (report) => this.emit({ ...report, id: this.id }));
      }
    }, settings.thresholdMs);
    this.timer.unref();
  }

  private elapsed(): number { return performance.now() - this.started; }
  private recordBoundary(event: string, outcome?: string): void {
    try {
      this.settings.record?.({ event, id: this.id, ...this.identity, stage: this.callStage,
        execution: this.sync ? "sync" : "async", monotonicMs: monotonicMs(),
        elapsedMs: this.elapsed(), thresholdMs: this.settings.thresholdMs, outcome, aggregate: { ...accounting },
        ...(event === "call-end" && this.settings.retainCommands?.includes(String(this.identity.command))
          ? { lifecycle: this.snapshot() } : {}) });
    } catch { /* Best effort, including a failing filesystem sink. */ }
  }
  private emit(report: GitDiagnosticReport): void {
    // Diagnostic failures must never replace a Git result or throw in a timer.
    try { this.settings.emit(report); } catch { /* Best effort. */ }
  }
  snapshot(): GitDiagnosticReport {
    const child = this.child;
    return { id: this.id, ...this.identity, elapsedMs: this.elapsed(), thresholdMs: this.settings.thresholdMs,
      timerLatenessMs: this.timerLatenessMs, settled: this.settled,
      pid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode,
      killed: child?.killed, connected: child?.connected,
      execution: this.sync ? "sync" : "async", stage: this.callStage,
      terminationObserved: this.sync ? null : this.events.some((item) => item.event === "exit"),
      childCloseObserved: this.sync ? null : this.closed,
      bytes: this.sync ? null : { ...this.bytes }, lastActivityMs: this.sync ? null : { ...this.lastActivityMs },
      byteCountBasis: this.sync ? "not observed for synchronous calls" : "delivered chunks; UTF-8 byte length for decoded strings",
      streams: this.sync ? null : { stdin: streamState(child?.stdin), stdout: streamState(child?.stdout), stderr: streamState(child?.stderr) },
      timeline: [...this.events] };
  }
  private report(event: string): void { this.emit({ event, ...this.snapshot() }); }
  /** Report an existing early-completion policy even below the slow trigger. */
  flag(event: string): void { this.slow = true; this.report(event); }
  event(event: string, code?: number | null, signal?: string | null): void {
    if (this.disposed) return;
    if (this.events.length < 64) this.events.push({ atMs: this.elapsed(), event, code, signal });
    if (this.slow) this.report(event);
  }
  attach(child: ChildProcess): void {
    this.child = child;
    const on = (emitter: NodeJS.EventEmitter, name: string | symbol, listener: (...args: any[]) => void): void => {
      emitter.on(name, listener);
      this.removers.push(() => emitter.removeListener(name, listener));
    };
    on(child, "spawn", () => this.event("spawn"));
    on(child, "exit", (code: number | null, signal: string | null) => this.event("exit", code, signal));
    on(child, errorMonitor, () => this.event("child-error"));
    on(child, "close", (code: number | null, signal: string | null) => {
      this.closed = true;
      this.event("child-close", code, signal);
      if (this.settled) this.dispose();
    });
    for (const name of ["stdin", "stdout", "stderr"] as const) {
      const stream = child[name];
      if (!stream) continue;
      for (const event of ["end", "finish", "close"]) on(stream, event, () => this.event(`${name}-${event}`));
      on(stream, errorMonitor, () => this.event(`${name}-error`));
    }
  }
  /** Dugite execFile already consumes both pipes in flowing mode. These
   * counters observe its existing data events; they never read/resume/pipe. */
  observeExecFileOutput(child: ChildProcess): void {
    for (const name of ["stdout", "stderr"] as const) {
      const stream = child[name];
      if (!stream) continue;
      const count = (chunk: Buffer | string): void => this.output(name, chunk);
      stream.on("data", count);
      this.removers.push(() => stream.removeListener("data", count));
    }
  }
  /** Called by the existing consumer, never by a second stream reader. */
  output(name: StreamName, chunk: Buffer | string): void {
    this.bytes[name] += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    this.lastActivityMs[name] = this.elapsed();
  }
  settle(outcome: "resolved" | "rejected"): void {
    if (this.settled || this.disposed) return;
    this.settled = true;
    clearTimeout(this.timer);
    const duration = this.elapsed();
    for (const totals of this.callAccounting) {
      totals.completed++;
      totals.rejected += outcome === "rejected" ? 1 : 0;
      totals.sumMs += duration;
      totals.maxMs = Math.max(totals.maxMs, duration);
    }
    this.recordBoundary("call-end", outcome);
    // A synchronous call or starved loop may settle before its overdue timer.
    if (!this.slow && this.elapsed() >= this.settings.thresholdMs) {
      this.slow = true;
      this.report("slow-settlement-before-timer");
    }
    this.event(`${this.sync ? "call" : "promise"}-${outcome}`);
    recent.push(this.snapshot());
    if (recent.length > 12) recent.shift();
    if (!this.child || this.closed) this.dispose();
    else {
      // Observe close after settlement without keeping listeners indefinitely
      // when the existing helper deliberately destroys/unrefs its streams.
      this.cleanupTimer = setTimeout(() => this.dispose("observation-ended"), 1000);
      this.cleanupTimer.unref();
    }
  }
  dispose(reason?: string): void {
    if (this.disposed) return;
    if (reason && (!this.settled || this.slow)) this.report(reason);
    if (this.settings.retainCommands?.includes(String(this.identity.command))) {
      try { this.settings.record?.({ event: "call-lifecycle-final", ...this.snapshot(),
        monotonicMs: monotonicMs(), aggregate: { ...accounting },
        observationEnd: reason ?? "completed" }); } catch { /* Best effort. */ }
    }
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.cleanupTimer);
    this.cancelSample?.();
    for (const remove of this.removers) remove();
    const index = recent.findIndex((report) => report.id === this.id);
    if (index >= 0) recent[index] = this.snapshot();
    active.delete(this);
  }
}

export function beginGitDiagnostic(source: string, args: string[], cwd: string): GitDiagnostic | undefined {
  if (!scope) return undefined;
  const identity: GitDiagnosticReport = { source, ...safeGitIdentity(args, cwd),
    nativeCwd: source === "system-git-sync" ? "repository" : "os.tmpdir" };
  const thresholdMs = scope.commandThresholdsMs?.[String(identity.command)] ?? scope.thresholdMs;
  return new GitDiagnostic({ ...scope, thresholdMs }, identity);
}
