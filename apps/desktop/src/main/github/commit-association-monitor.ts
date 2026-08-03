export const COMMIT_ASSOCIATION_POLL_INTERVAL_MS = 60_000;

type CommitAssociationMonitorDeps = {
  refresh: (repoId: string, commitHashes: string[]) => Promise<void>;
};

/** Polls only still-unassociated visible commits, unioned across graph reasons. */
export class CommitAssociationMonitor {
  private readonly reasons = new Map<
    string,
    { repoId: string; commitHashes: Set<string> }
  >();
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: CommitAssociationMonitorDeps) {}

  replace(reasonId: string, repoId: string, commitHashes: string[]): void {
    if (this.stopped) return;
    const hashes = new Set(commitHashes);
    if (hashes.size === 0) this.reasons.delete(reasonId);
    else this.reasons.set(reasonId, { repoId, commitHashes: hashes });
    if (this.reasons.size === 0) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    } else {
      this.schedulePoll();
    }
  }

  async pollNow(): Promise<void> {
    if (this.stopped) return;
    const byRepo = new Map<string, Set<string>>();
    for (const { repoId, commitHashes } of this.reasons.values()) {
      const hashes = byRepo.get(repoId) ?? new Set<string>();
      for (const hash of commitHashes) hashes.add(hash);
      byRepo.set(repoId, hashes);
    }
    await Promise.all([...byRepo].map(
      async ([repoId, hashes]) => await this.deps.refresh(repoId, [...hashes])
    ));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.reasons.clear();
  }

  private schedulePoll(): void {
    if (this.stopped || this.timer !== null || this.reasons.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollNow().finally(() => this.schedulePoll());
    }, COMMIT_ASSOCIATION_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }
}
