export const PR_STATUS_POLL_INTERVAL_MS = 60_000;

export type PrMonitorTarget = { repoId: string; number: number };

type PrStatusMonitorDeps = {
  refresh: (repoId: string, numbers: number[]) => Promise<void>;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
};

const targetKey = ({ repoId, number }: PrMonitorTarget): string =>
  `${repoId}\0${number}`;

/**
 * Reference-counted by reason set, deduplicated by repository + PR number.
 * Every caller atomically replaces its complete reason, so overlapping PRs
 * remain continuously monitored without remove/add churn.
 */
export class PrStatusMonitor {
  private readonly reasons = new Map<string, Map<string, PrMonitorTarget>>();
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: PrStatusMonitorDeps) {
    this.setTimer = deps.setTimer ?? globalThis.setTimeout;
    this.clearTimer = deps.clearTimer ?? globalThis.clearTimeout;
  }

  replace(reasonId: string, targets: readonly PrMonitorTarget[]): void {
    if (this.stopped) return;
    const reason = reasonId.trim();
    if (reason === "") return;
    const next = new Map<string, PrMonitorTarget>();
    for (const target of targets) {
      const repoId = target.repoId.trim();
      if (repoId === "" || !Number.isSafeInteger(target.number) || target.number <= 0) {
        continue;
      }
      const normalized = { repoId, number: target.number };
      next.set(targetKey(normalized), normalized);
    }
    if (next.size === 0) this.reasons.delete(reason);
    else this.reasons.set(reason, next);

    if (this.reasons.size === 0) {
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
    } else {
      this.schedulePoll();
    }
  }

  async pollNow(): Promise<void> {
    if (this.stopped) return;
    await Promise.all([...this.watchedByRepo()].map(
      async ([repoId, numbers]) => await this.deps.refresh(repoId, [...numbers])
    ));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.reasons.clear();
  }

  private watchedByRepo(): Map<string, Set<number>> {
    const watched = new Map<string, Set<number>>();
    const unique = new Map<string, PrMonitorTarget>();
    for (const reason of this.reasons.values()) {
      for (const [key, target] of reason) unique.set(key, target);
    }
    for (const { repoId, number } of unique.values()) {
      const numbers = watched.get(repoId) ?? new Set<number>();
      numbers.add(number);
      watched.set(repoId, numbers);
    }
    return watched;
  }

  private schedulePoll(): void {
    if (this.stopped || this.timer !== null || this.reasons.size === 0) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.pollNow().finally(() => this.schedulePoll());
    }, PR_STATUS_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }
}
