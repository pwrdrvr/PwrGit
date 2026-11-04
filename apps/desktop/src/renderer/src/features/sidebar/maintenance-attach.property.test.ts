import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_MAINTENANCE_RUN_VIEW,
  foldMaintenanceProgress,
  type MaintenanceCurrent,
  type MaintenanceProgress,
  type MaintenanceRepo,
  type MaintenanceRepoResult,
  type MaintenanceRunRecord,
  type MaintenanceRunView,
  type MaintenanceSummary
} from "@pwrgit/shared";

const { dispatch, subscribe } = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));
import { attachMaintenanceRun, reopensAfterReload, showsOnOpen } from "./maintenance-attach";

/** mulberry32: a seeded generator, so a failure prints a case to replay. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (next: () => number, low: number, high: number): number =>
  low + Math.floor(next() * (high - low + 1));

const repo = (id: string): MaintenanceRepo => ({ id, name: id, path: `/fixtures/${id}`, profileId: "one", profileName: "One" });
const run: MaintenanceRunRecord = {
  operationId: "op",
  profileId: "one",
  allProfiles: false,
  action: { kind: "gc", mode: "standard" },
  startedAt: "2026-11-04T12:00:00Z",
  ownWindow: true
};

/**
 * A run the way main emits one: `starting`, then each repository's queued
 * line, start, progress lines and result, interleaved across repositories
 * (`mapLimit` runs several at once), then `finished`. Numbered as main
 * numbers them.
 */
function emittedRun(next: () => number): { events: MaintenanceProgress[]; summary: MaintenanceSummary } {
  const repos = Array.from({ length: pick(next, 1, 4) }, (_, index) => repo(`r${index}`));
  const lanes = repos.map((item) => {
    const lines = Array.from({ length: pick(next, 0, 3) }, (_, line) => `${item.id} step ${line}`);
    const result: MaintenanceRepoResult = { repo: item, outcome: next() < 0.8 ? "success" : "failed", message: `${item.id} done` };
    return [
      { phase: "repo_progress" as const, repo: item, detail: "Waiting for the repository lock…" },
      { phase: "repo_started" as const, repo: item },
      ...lines.map((detail) => ({ phase: "repo_progress" as const, repo: item, detail })),
      { phase: "repo_completed" as const, repo: item, result }
    ];
  });
  const body: Omit<MaintenanceProgress, "operationId" | "profileId">[] = [{ phase: "starting", repos }];
  while (lanes.some((lane) => lane.length > 0)) {
    const open = lanes.filter((lane) => lane.length > 0);
    body.push(open[pick(next, 0, open.length - 1)]!.shift()!);
  }
  const results = body.flatMap((event) => (event.result === undefined ? [] : [event.result]));
  const summary: MaintenanceSummary = {
    operationId: "op",
    startedAt: run.startedAt,
    finishedAt: "2026-11-04T12:05:00Z",
    cancelled: false,
    results: repos.map((item) => results.find((result) => result.repo.id === item.id)!)
  };
  body.push({ phase: "finished", summary });
  return {
    events: body.map((event, index) => ({ ...event, operationId: "op", profileId: "one", seq: index + 1 })),
    summary
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.resetAllMocks());

describe("reattaching to a maintenance run", () => {
  // The rule: a window that reloads anywhere in a run, and hears main's
  // answer anywhere among the live events, ends up drawing exactly what a
  // window that watched from the start draws, and sees the receipt once.
  it("draws the same run as a window that watched it all, wherever the reload lands", async () => {
    const seed = Date.now() >>> 0;
    const next = random(seed);
    for (let trial = 0; trial < 200; trial++) {
      const { events, summary } = emittedRun(next);
      const finishedAt = events.length - 1;
      // The reloaded page subscribes after `subscribedAt` events have gone
      // by unheard; main takes its snapshot after `snapshotAt` (no earlier:
      // the question is sent after subscribing; before `finished`, or main
      // would answer with the receipt); the answer reaches the page after
      // `answeredAt` events, earlier or later than the snapshot.
      const subscribedAt = pick(next, 0, finishedAt);
      const snapshotAt = pick(next, subscribedAt, finishedAt);
      const answeredAt = pick(next, subscribedAt, events.length);
      const watched = events.slice(0, finishedAt).reduce(foldMaintenanceProgress, EMPTY_MAINTENANCE_RUN_VIEW);
      const snapshot = events.slice(0, snapshotAt).reduce(foldMaintenanceProgress, EMPTY_MAINTENANCE_RUN_VIEW);
      const replay = { seed, trial, subscribedAt, snapshotAt, answeredAt, events: events.length };

      let hear: ((event: MaintenanceProgress) => void) | null = null;
      subscribe.mockImplementation((_name: string, listener: (event: MaintenanceProgress) => void) => {
        hear = listener;
        return () => {
          hear = null;
        };
      });
      let answer!: (value: { ok: true; value: MaintenanceCurrent }) => void;
      dispatch.mockImplementation((name: string) =>
        name === "maintenance:current"
          ? new Promise((resolve) => (answer = resolve))
          : Promise.resolve({ ok: true, value: null })
      );
      let drawn: MaintenanceRunView | null = null;
      const finished: (MaintenanceSummary | null)[] = [];
      attachMaintenanceRun("one", {
        claim: () => true,
        running: (_run, view) => (drawn = view),
        progress: (view) => (drawn = view),
        finished: (_run, receipt) => finished.push(receipt)
      });
      for (let index = subscribedAt; index < events.length; index++) {
        if (index === answeredAt) {
          answer({ ok: true, value: { state: "running", run, view: snapshot } });
          await settle();
        }
        (hear as ((event: MaintenanceProgress) => void) | null)?.(events[index]!);
      }
      if (answeredAt === events.length) {
        answer({ ok: true, value: { state: "running", run, view: snapshot } });
        await settle();
      }
      expect({ ...replay, drawn }).toEqual({ ...replay, drawn: watched });
      expect({ ...replay, finished }).toEqual({ ...replay, finished: [summary] });
      expect(dispatch).toHaveBeenCalledWith("maintenance:seen", { profileId: "one", operationId: "op" });
      expect(hear).toBeNull();
      vi.resetAllMocks();
    }
  });

  it("ignores another profile's events and another run's", async () => {
    let hear!: (event: MaintenanceProgress) => void;
    subscribe.mockImplementation((_name: string, listener: (event: MaintenanceProgress) => void) => {
      hear = listener;
      return () => undefined;
    });
    dispatch.mockResolvedValue({ ok: true, value: { state: "running", run, view: EMPTY_MAINTENANCE_RUN_VIEW } });
    const drawn: MaintenanceRunView[] = [];
    attachMaintenanceRun("one", {
      claim: () => true,
      running: () => undefined,
      progress: (view) => drawn.push(view),
      finished: () => undefined
    });
    await settle();
    hear({ operationId: "op", profileId: "two", phase: "starting", seq: 1, repos: [repo("theirs")] });
    hear({ operationId: "other", profileId: "one", phase: "starting", seq: 1, repos: [repo("older")] });
    expect(drawn).toEqual([]);
  });

  it("says which answers a dialog shows, and which reopen it after a reload", () => {
    const summary: MaintenanceSummary = { operationId: "op", startedAt: run.startedAt, finishedAt: run.startedAt, cancelled: false, results: [] };
    const running: MaintenanceCurrent = { state: "running", run, view: EMPTY_MAINTENANCE_RUN_VIEW };
    const unseen: MaintenanceCurrent = { state: "finished", run, summary, seen: false };
    const seen: MaintenanceCurrent = { state: "finished", run, summary, seen: true };
    const elsewhere: MaintenanceCurrent = { ...running, run: { ...run, ownWindow: false } };
    expect([null, running, unseen, seen, elsewhere].map(showsOnOpen)).toEqual([false, true, true, false, true]);
    // Another window's run is shown when asked for, but never opens itself.
    expect([null, running, unseen, seen, elsewhere].map(reopensAfterReload)).toEqual([false, true, true, false, false]);
  });
});
