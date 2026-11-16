import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

export type ResourceSource = "bulk-fetch" | "bulk-pull" | "active-refresh" |
  "visible-refresh" | "remote-check" | "authored-sweep" | "root-discovery" | "other";
const source = new AsyncLocalStorage<ResourceSource>();

/** Async work retains its origin through queues and completion callbacks. */
export function withResourceSource<T>(name: ResourceSource, work: () => T): T {
  return source.run(name, work);
}

// Bounded labels only: no arguments, repository paths, ref names or URLs.
const COMMANDS = new Set([
  "status", "log", "config", "rev-parse", "rev-list", "merge-base", "for-each-ref",
  "fetch", "push", "merge", "worktree", "branch", "ls-remote", "show", "diff",
  "ls-files", "ls-tree", "cat-file", "symbolic-ref", "remote", "stash", "update-ref",
  "check-ref-format", "reflog", "tag", "commit", "switch", "checkout", "rebase"
]);

export function gitResourceCommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") { i++; continue; }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) continue;
    return COMMANDS.has(arg) ? arg : "other";
  }
  return "other";
}

export type GitResourceBucket = {
  source: ResourceSource;
  command: string;
  started: number;
  completed: number;
  nonzero: number;
  /** Overlapping process lifetimes add; this is NOT CPU time. */
  wallMs: number;
  active: number;
};

/** Constant-sized counters; a long-running child keeps its label across samples. */
export class GitResourceUsage {
  private readonly buckets = new Map<string, GitResourceBucket>();
  private active = 0;
  private peak = 0;

  start(args: readonly string[], origin: ResourceSource, at = performance.now()): (nonzero: boolean, end?: number) => void {
    const command = gitResourceCommand(args);
    const key = `${origin}:${command}`;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { source: origin, command, started: 0, completed: 0, nonzero: 0, wallMs: 0, active: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.started++;
    bucket.active++;
    this.peak = Math.max(this.peak, ++this.active);
    let finished = false;
    return (nonzero, end = performance.now()) => {
      if (finished) return;
      finished = true;
      bucket.completed++;
      bucket.nonzero += Number(nonzero);
      bucket.wallMs += Math.max(0, end - at);
      bucket.active--;
      this.active--;
    };
  }

  sample(): { active: number; peak: number; buckets: GitResourceBucket[] } {
    const buckets = [...this.buckets.values()]
      .filter((b) => b.started > 0 || b.completed > 0 || b.active > 0)
      .map((b) => ({ ...b, wallMs: Math.round(b.wallMs) }));
    const peak = this.peak;
    for (const b of this.buckets.values()) {
      b.started = b.completed = b.nonzero = b.wallMs = 0;
    }
    this.peak = this.active;
    return { active: this.active, peak, buckets };
  }
}

export const gitResourceUsage = new GitResourceUsage();

/** Observe real spawns in all three Git adapters, rather than IPC requests. */
export function observeGitResources(child: ChildProcess, args: readonly string[]): void {
  const origin = source.getStore() ?? "other";
  child.once("spawn", () => {
    const finish = gitResourceUsage.start(args, origin);
    child.once("close", (code) => finish(code !== 0));
  });
}

export type ResourceProcess = {
  pid: number;
  creationTime: number;
  type: string;
  cpu: { cumulativeCPUUsage?: number };
};

/** Cumulative counters avoid interference from other getAppMetrics callers. */
export class ProcessResourceUsage {
  private previous = new Map<string, number>();
  private initialized = false;

  sample(metrics: readonly ResourceProcess[]): Array<{ pid: number; type: string; cpuSeconds: number | null }> {
    const next = new Map<string, number>();
    const result = metrics.map((metric) => {
      const key = `${metric.pid}:${metric.creationTime}`;
      const value = metric.cpu.cumulativeCPUUsage;
      const valid = value !== undefined && Number.isFinite(value) && value >= 0;
      if (valid) next.set(key, value);
      const before = this.previous.get(key);
      const delta = !valid ? null : before !== undefined ? Math.max(0, value - before) : this.initialized ? value : null;
      return { pid: metric.pid, type: metric.type, cpuSeconds: delta === null ? null : Math.round(delta * 1000) / 1000 };
    });
    this.previous = next;
    this.initialized = true;
    return result;
  }
}
