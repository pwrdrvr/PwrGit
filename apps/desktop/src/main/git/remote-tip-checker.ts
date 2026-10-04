import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";
import { ok, type Result, type Res } from "@pwrgit/shared";
import { VISIBLE_REPORT_CAP } from "./visible-refresh";

export const REMOTE_VISIBLE_DEBOUNCE_MS = 500;
export const REMOTE_VISIBLE_INTERVAL_MS = 60_000;
export type RemoteCheckReason = "visible" | "focus" | "periodic" | "selected" | "hover";
type Answer = Result<Res<"remote:checkSelected">>;
export type RemoteCheckRequest = { reason: RemoteCheckReason; userAction: boolean };
export type RemoteCheckHandle = { result: Promise<Answer>; cancel: () => void };
type Entry = RemoteCheckHandle & {
  id: string;
  key: string;
  repository: string;
  canceled: boolean;
  started: boolean;
  resolve: (answer: Answer) => void;
};
type Batch = {
  repository: string;
  reason: RemoteCheckReason;
  entries: Entry[];
  started: boolean;
  timer?: ReturnType<typeof setTimeout> | undefined;
};
type Dependencies = {
  isFocused: () => boolean;
  now?: () => number;
  keyFor?: (id: string) => string;
  repositoryFor?: (id: string) => string;
  check: (ids: string[], request: RemoteCheckRequest) => Promise<Map<string, Answer>>;
};

/** Queue repository batches, while retaining each checkout/branch's own
 * answer and cancellation handle. Only deliberate hover/selection bypasses
 * repository freshness; a newly visible branch waits for the next batch. */
export class RemoteTipChecker {
  private readonly reports = new Map<number, Set<string>>();
  private readonly visible = new Map<string, RemoteCheckHandle>();
  private readonly background = new Map<string, Entry>();
  private readonly direct = new Map<string, Entry>();
  private readonly backgroundBatches = new Map<string, Batch>();
  private readonly directBatches = new Map<string, Batch>();
  /** Deliberate direct checks do not postpone other branches' next round. */
  private readonly lastFinished = new Map<string, number>();
  private readonly answers = new Map<string, { at: number; repository: string; answer: Answer }>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly backgroundQueue: IterableQueueMapperSimple<Batch>;
  private readonly directQueue: IterableQueueMapperSimple<Batch>;
  private stopped = false;

  constructor(private readonly deps: Dependencies) {
    this.backgroundQueue = new IterableQueueMapperSimple((batch) => this.run(batch), { concurrency: 4 });
    this.directQueue = new IterableQueueMapperSimple((batch) => this.run(batch), { concurrency: 2 });
  }

  private key(id: string): string { return this.deps.keyFor?.(id) ?? id; }
  private repository(id: string): string { return this.deps.repositoryFor?.(id) ?? this.key(id); }

  request(id: string, reason: RemoteCheckReason): RemoteCheckHandle {
    const key = this.key(id);
    const repository = this.repository(id);
    const immediate = reason === "selected" || reason === "hover";
    const existing = this.direct.get(key) ?? this.background.get(key);
    if (existing !== undefined && !existing.canceled) {
      if (!immediate && this.direct.has(key)) return { result: existing.result, cancel: () => undefined };
      const queued = this.directBatches.get(repository);
      if (reason === "hover" && queued !== undefined && !queued.started) queued.reason = reason;
      if (!immediate || existing.started || this.direct.has(key)) return existing;
      existing.cancel(); // Move this member to the direct lane, retaining its siblings.
    }
    let resolve!: (answer: Answer) => void;
    const result = new Promise<Answer>((settle) => { resolve = settle; });
    const owners = immediate ? this.direct : this.background;
    const entry: Entry = {
      id, key, repository, result, resolve, canceled: false, started: false,
      cancel: () => {
        if (entry.started) return;
        entry.canceled = true;
        if (owners.get(key) === entry) owners.delete(key);
        resolve(ok({ status: "superseded" }));
      }
    };
    if (this.stopped) { entry.cancel(); return entry; }
    owners.set(key, entry);
    const batches = immediate ? this.directBatches : this.backgroundBatches;
    let batch = batches.get(repository);
    if (batch === undefined || batch.started) {
      batch = { repository, reason, entries: [entry], started: false };
      batches.set(repository, batch);
      const pending = batch;
      const enqueue = (): void => {
        pending.timer = undefined;
        void (immediate ? this.directQueue : this.backgroundQueue).enqueue(pending);
      };
      // Direct requests join during this turn; viewport requests join across
      // the debounce window. Tombstones are filtered when the batch dequeues.
      if (immediate) enqueue();
      else batch.timer = setTimeout(enqueue, REMOTE_VISIBLE_DEBOUNCE_MS);
    } else {
      if (reason === "hover") batch.reason = reason;
      batch.entries.push(entry);
    }
    return entry;
  }

  report(webContentsId: number, ids: readonly string[]): void {
    this.reports.set(webContentsId, new Set(ids.slice(0, VISIBLE_REPORT_CAP)));
    this.reconcile("visible");
  }
  releaseWebContents(webContentsId: number): void { this.reports.delete(webContentsId); this.reconcile("visible"); }
  focus(): void { this.reconcile("focus"); }
  tick(): void { this.reconcile("periodic"); }

  /** An explicit Git operation supersedes queued checks and their freshness. */
  invalidateRepository(repository: string): void {
    this.generations.set(repository, (this.generations.get(repository) ?? 0) + 1);
    this.lastFinished.delete(repository);
    for (const [key, cached] of this.answers) if (cached.repository === repository) this.answers.delete(key);
    for (const entry of [...this.background.values(), ...this.direct.values()]) {
      if (entry.repository === repository) entry.cancel();
    }
  }

  stop(): void {
    this.stopped = true;
    for (const entry of [...this.background.values(), ...this.direct.values()]) entry.cancel();
    for (const batch of [...this.backgroundBatches.values(), ...this.directBatches.values()]) clearTimeout(batch.timer);
    this.reports.clear(); this.visible.clear(); this.lastFinished.clear(); this.answers.clear();
  }

  private reconcile(reason: RemoteCheckReason): void {
    const ids = new Set([...this.reports.values()].flatMap((set) => [...set]));
    for (const [id, handle] of this.visible) {
      if (!ids.has(id)) { handle.cancel(); this.visible.delete(id); }
    }
    const now = (this.deps.now ?? Date.now)();
    for (const [repository, at] of this.lastFinished) {
      if (now - at >= REMOTE_VISIBLE_INTERVAL_MS) this.lastFinished.delete(repository);
    }
    for (const [key, { at }] of this.answers) {
      if (now - at >= REMOTE_VISIBLE_INTERVAL_MS) this.answers.delete(key);
    }
    if (this.stopped || !this.deps.isFocused()) return;
    for (const id of ids) {
      if (now - (this.lastFinished.get(this.repository(id)) ?? -Infinity) < REMOTE_VISIBLE_INTERVAL_MS) continue;
      this.visible.set(id, this.request(id, reason));
    }
  }

  private async run(batch: Batch): Promise<void> {
    batch.started = true;
    const immediate = batch.reason === "selected" || batch.reason === "hover";
    const valid = (entry: Entry): boolean => {
      if (entry.canceled) return false;
      if (this.stopped || this.key(entry.id) !== entry.key || this.repository(entry.id) !== batch.repository ||
          (!immediate && !this.deps.isFocused())) {
        entry.cancel();
        return false;
      }
      return true;
    };
    let entries = batch.entries.filter(valid);
    if (entries.length === 0) { this.forget(batch); return; }
    // A direct batch and a background batch must not advertise the same repo
    // concurrently. Recheck freshness, branch and cancellation after waiting.
    while (this.running.has(batch.repository)) await this.running.get(batch.repository);
    entries = entries.filter(valid);
    const now = this.deps.now ?? Date.now;
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (entries.length === 0) return;
      if (!immediate && now() - (this.lastFinished.get(batch.repository) ?? -Infinity) < REMOTE_VISIBLE_INTERVAL_MS) {
        for (const entry of entries) {
          const cached = this.answers.get(entry.key);
          entry.resolve(cached !== undefined && now() - cached.at < REMOTE_VISIBLE_INTERVAL_MS
            ? cached.answer : ok({ status: "unavailable" }));
        }
        return;
      }
      if (!immediate && entries.every((entry) => {
        const cached = this.answers.get(entry.key);
        return cached !== undefined && now() - cached.at < REMOTE_VISIBLE_INTERVAL_MS;
      })) {
        // A direct check can satisfy these exact members. It cannot satisfy
        // another branch or renew that other branch's automatic cooldown.
        for (const entry of entries) entry.resolve(this.answers.get(entry.key)!.answer);
        return;
      }
      this.running.set(batch.repository, running);
      const generation = this.generations.get(batch.repository) ?? 0;
      for (const entry of entries) entry.started = true;
      let answers: Map<string, Answer>;
      try {
        const request = { reason: batch.reason, userAction: batch.reason !== "periodic" };
        answers = await this.deps.check(entries.map((entry) => entry.id), request);
      } catch {
        answers = new Map(entries.map((entry) => [entry.id, ok({ status: "unavailable" })]));
      }
      let learned = false;
      for (const entry of entries) {
        const received: Answer = answers.get(entry.id) ?? ok({ status: "unavailable" });
        // A completed advertisement spends the repo's budget even if this
        // checkout switched branches meanwhile. Do not cache its old answer.
        if (!this.stopped && (this.generations.get(batch.repository) ?? 0) === generation &&
            (!received.ok || received.value.status !== "superseded")) learned = true;
        const current = !this.stopped && this.key(entry.id) === entry.key && this.repository(entry.id) === batch.repository &&
          (this.generations.get(batch.repository) ?? 0) === generation;
        const answer: Answer = current ? received : ok({ status: "superseded" });
        if (answer.ok && answer.value.status !== "superseded") {
          this.answers.set(entry.key, { at: now(), repository: batch.repository, answer });
          learned = true;
        }
        entry.resolve(answer);
      }
      if (learned && !immediate) this.lastFinished.set(batch.repository, now());
    } finally {
      if (this.running.get(batch.repository) === running) this.running.delete(batch.repository);
      release();
      this.forget(batch);
    }
  }

  private forget(batch: Batch): void {
    const immediate = batch.reason === "selected" || batch.reason === "hover";
    const owners = immediate ? this.direct : this.background;
    const batches = immediate ? this.directBatches : this.backgroundBatches;
    for (const entry of batch.entries) if (owners.get(entry.key) === entry) owners.delete(entry.key);
    if (batches.get(batch.repository) === batch) batches.delete(batch.repository);
  }
}
