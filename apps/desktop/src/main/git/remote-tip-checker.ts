import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";
import { ok, type Result, type Res } from "@pwrgit/shared";
import { VISIBLE_REPORT_CAP } from "./visible-refresh";

export const REMOTE_VISIBLE_DEBOUNCE_MS = 500;
export const REMOTE_VISIBLE_INTERVAL_MS = 60_000;
export type RemoteCheckReason = "visible" | "focus" | "periodic" | "selected" | "hover";
type Answer = Result<Res<"remote:checkSelected">>;
export type RemoteCheckHandle = { result: Promise<Answer>; cancel: () => void };
type Entry = RemoteCheckHandle & {
  id: string;
  key: string;
  reason: RemoteCheckReason;
  canceled: boolean;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (answer: Answer) => void;
};

/** The same debounce/tombstone pattern as asyncFill, with main owning the
 * process budget across windows. Visibility is user intent, but only hover
 * and selection use the immediate lane; a scroll cannot fill that lane. */
export class RemoteTipChecker {
  private readonly reports = new Map<number, Set<string>>();
  private readonly visible = new Map<string, RemoteCheckHandle>();
  private readonly background = new Map<string, Entry>();
  private readonly direct = new Map<string, Entry>();
  private readonly lastFinished = new Map<string, number>();
  private readonly backgroundQueue: IterableQueueMapperSimple<Entry>;
  private readonly directQueue: IterableQueueMapperSimple<Entry>;
  private stopped = false;

  constructor(private readonly deps: {
    check: (id: string, request: { reason: RemoteCheckReason; userAction: boolean }) => Promise<Answer>;
    isFocused: () => boolean;
    now?: () => number;
    keyFor?: (id: string) => string;
  }) {
    this.backgroundQueue = new IterableQueueMapperSimple((entry) => this.run(entry), { concurrency: 4 });
    this.directQueue = new IterableQueueMapperSimple((entry) => this.run(entry), { concurrency: 2 });
  }

  request(id: string, reason: RemoteCheckReason): RemoteCheckHandle {
    const key = this.deps.keyFor?.(id) ?? id;
    const immediate = reason === "selected" || reason === "hover";
    const existing = this.direct.get(key) ?? this.background.get(key);
    if (existing !== undefined && !existing.canceled) {
      if (!immediate && this.direct.has(key)) return { result: existing.result, cancel: () => undefined };
      if (reason === "hover" && this.direct.has(key) && !existing.started) existing.reason = "hover";
      if (!immediate || existing.started || this.direct.has(key)) return existing;
      existing.cancel(); // Promote queued viewport work without waiting behind it.
    }
    let resolve!: (answer: Answer) => void;
    const result = new Promise<Answer>((settle) => { resolve = settle; });
    const owners = immediate ? this.direct : this.background;
    const entry: Entry = {
      id, key, reason, result, resolve, canceled: false, started: false, timer: undefined,
      cancel: () => {
        if (entry.started) return; // Already-running checks keep their 12s timeout.
        entry.canceled = true;
        clearTimeout(entry.timer);
        if (owners.get(key) === entry) owners.delete(key);
        resolve(ok({ status: "superseded" }));
      }
    };
    if (this.stopped) { entry.cancel(); return entry; }
    owners.set(key, entry);
    const enqueue = (): void => {
      entry.timer = undefined;
      void (immediate ? this.directQueue : this.backgroundQueue).enqueue(entry);
    };
    if (immediate) enqueue();
    else entry.timer = setTimeout(enqueue, REMOTE_VISIBLE_DEBOUNCE_MS);
    return entry;
  }

  report(webContentsId: number, ids: readonly string[]): void {
    this.reports.set(webContentsId, new Set(ids.slice(0, VISIBLE_REPORT_CAP)));
    this.reconcile("visible");
  }

  releaseWebContents(webContentsId: number): void {
    this.reports.delete(webContentsId);
    this.reconcile("visible");
  }

  focus(): void { this.reconcile("focus"); }
  tick(): void { this.reconcile("periodic"); }

  stop(): void {
    this.stopped = true;
    for (const entry of [...this.background.values(), ...this.direct.values()]) entry.cancel();
    this.reports.clear();
    this.visible.clear();
    this.lastFinished.clear();
  }

  private reconcile(reason: RemoteCheckReason): void {
    const ids = new Set([...this.reports.values()].flatMap((set) => [...set]));
    for (const [id, handle] of this.visible) {
      if (!ids.has(id)) { handle.cancel(); this.visible.delete(id); }
    }
    const now = (this.deps.now ?? Date.now)();
    // Retain freshness across scrolling/lens changes, but only for its TTL.
    for (const [key, at] of this.lastFinished) {
      if (now - at >= REMOTE_VISIBLE_INTERVAL_MS) this.lastFinished.delete(key);
    }
    if (this.stopped || !this.deps.isFocused()) return;
    for (const id of ids) {
      const key = this.deps.keyFor?.(id) ?? id;
      if (now - (this.lastFinished.get(key) ?? -Infinity) < REMOTE_VISIBLE_INTERVAL_MS) continue;
      this.visible.set(id, this.request(id, reason));
    }
  }

  private async run(entry: Entry): Promise<void> {
    if (entry.canceled || this.stopped) return;
    if (this.deps.keyFor !== undefined && this.deps.keyFor(entry.id) !== entry.key) {
      entry.cancel(); // A checkout changed branch while this request waited.
      return;
    }
    const immediate = entry.reason === "selected" || entry.reason === "hover";
    const now = this.deps.now ?? Date.now;
    if (!immediate && (!this.deps.isFocused() || now() - (this.lastFinished.get(entry.key) ?? -Infinity) < REMOTE_VISIBLE_INTERVAL_MS)) {
      // Focus or freshness can change while queued. Skips are not refreshes.
      entry.cancel();
      return;
    }
    entry.started = true;
    try {
      const answer = await this.deps.check(entry.id, {
        reason: entry.reason, userAction: entry.reason !== "periodic"
      });
      if (answer.ok && answer.value.status !== "superseded" && (this.deps.keyFor?.(entry.id) ?? entry.key) === entry.key) {
        this.lastFinished.set(entry.key, now());
      }
      entry.resolve(answer);
    } catch {
      this.lastFinished.set(entry.key, now());
      entry.resolve(ok({ status: "unavailable" }));
    } finally {
      const owners = entry.reason === "selected" || entry.reason === "hover" ? this.direct : this.background;
      if (owners.get(entry.key) === entry) owners.delete(entry.key);
    }
  }
}
