import { createHash } from "node:crypto";

type RecordData = Record<string, unknown>;
type Call = { snapshot(): RecordData; dispose(): void };
const commands = new Set("add apply branch checkout clone commit config diff fetch init log merge pull push rebase remote reset rev-parse show stash status switch".split(" "));
let current: GitTripwire | undefined;

/** Test-only observation; no process control, stream listeners or output reads. */
export class GitTripwire {
  private readonly started = performance.now();
  private readonly calls = new Set<Call>();
  private readonly timer: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private count = 0;
  private totalMs = 0;
  private slowest: { command: string; elapsedMs: number }[] = [];

  constructor(private readonly sink: (row: RecordData) => void, readonly thresholdMs = 5000) {
    current = this;
    this.timer = setTimeout(() => this.summary("slow-test", true), thresholdMs);
    this.timer.unref();
  }
  private write(row: RecordData): void {
    try { this.sink({ monotonicMs: performance.now(), ...row }); } catch { /* Never change a Git result. */ }
  }
  private summary(event: string, alert: boolean): void {
    this.write({ event, alert, elapsedMs: performance.now() - this.started,
      completedCalls: this.count, totalGitMs: this.totalMs, slowest: [...this.slowest],
      active: [...this.calls].map(call => call.snapshot()) });
  }
  finish(failed = false): void {
    clearTimeout(this.timer);
    this.summary("test-end", failed || performance.now() - this.started >= this.thresholdMs);
    for (const call of this.calls) call.dispose();
    this.calls.clear();
    if (current === this) current = undefined;
  }
  begin(args: string[], cwd: string, execution: "sync" | "async", state: () => RecordData) {
    const started = performance.now();
    const id = ++this.sequence;
    const command = commands.has(args[0] ?? "") ? args[0]! : "other";
    const cwdId = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const timeline: { event: string; atMs: number }[] = [];
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = () => ({ id, command, cwdId, execution, elapsedMs: performance.now() - started,
      timeline: [...timeline], ...state() });
    const report = (event: string) => { if (!done) this.write({ event, alert: true, ...snapshot() }); };
    const call: Call = { snapshot, dispose: () => { done = true; clearTimeout(timer); } };
    this.calls.add(call);
    // Persist before execFileSync can block. A same-thread timer cannot inspect it.
    this.write({ event: "begin", ...snapshot() });
    if (execution === "async") {
      timer = setTimeout(() => this.write({ event: "slow-call", alert: true, ...snapshot(),
        timerLatenessMs: Math.max(0, performance.now() - started - this.thresholdMs) }), this.thresholdMs);
      timer.unref();
    }
    return {
      event: (event: string) => { if (!done && timeline.length < 16) timeline.push({ event, atMs: performance.now() - started }); },
      report,
      finish: (outcome: string) => {
        if (done) return;
        const elapsedMs = performance.now() - started;
        this.count++;
        this.totalMs += elapsedMs;
        this.slowest = [...this.slowest, { command, elapsedMs }].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 3);
        this.write({ event: "end", alert: elapsedMs >= this.thresholdMs, outcome, ...snapshot() });
        call.dispose();
        this.calls.delete(call);
      }
    };
  }
}

export function beginGitCall(args: string[], cwd: string, execution: "sync" | "async", state: () => RecordData = () => ({})) {
  return current?.begin(args, cwd, execution, state);
}

export function timedGitSync<T>(args: string[], cwd: string, run: () => T): T {
  const call = beginGitCall(args, cwd, "sync");
  try { const result = run(); call?.finish("returned"); return result; }
  catch (error) { call?.finish("threw"); throw error; }
}
