import fc from "fast-check";
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

const repo = (id: string): MaintenanceRepo => ({ id, name: id, path: `/fixtures/${id}`, profileId: "one", profileName: "One" });
const run: MaintenanceRunRecord = {
  operationId: "op",
  profileId: "one",
  allProfiles: false,
  action: { kind: "gc", mode: "standard" },
  startedAt: "2026-11-04T12:00:00Z",
  ownWindow: true
};
type Body = Omit<MaintenanceProgress, "operationId" | "profileId" | "seq">;

/**
 * A run the way main emits one: `starting`, then each repository's queued
 * line, start, progress lines and result, interleaved across repositories
 * (`mapLimit` runs several at once), then `finished`. Numbered as main
 * numbers them.
 */
const emittedRun = fc
  .array(
    fc.record({ lines: fc.nat({ max: 3 }), failed: fc.boolean() }),
    { minLength: 1, maxLength: 4 }
  )
  .chain((shapes) => {
    const repos = shapes.map((_, index) => repo(`r${index}`));
    const lanes: Body[][] = shapes.map((shape, index) => {
      const item = repos[index]!;
      const result: MaintenanceRepoResult = { repo: item, outcome: shape.failed ? "failed" : "success", message: `${item.id} done` };
      return [
        { phase: "repo_progress", repo: item, detail: "Waiting for the repository lock…" },
        { phase: "repo_started", repo: item },
        ...Array.from({ length: shape.lines }, (_, line): Body => ({ phase: "repo_progress", repo: item, detail: `${item.id} step ${line}` })),
        { phase: "repo_completed", repo: item, result }
      ];
    });
    const total = lanes.reduce((sum, lane) => sum + lane.length, 0);
    // Which running repository reports next, at each step.
    return fc.array(fc.nat(), { minLength: total, maxLength: total }).map((picks) => {
      const open = lanes.map((lane) => [...lane]);
      const body: Body[] = [{ phase: "starting", repos }];
      for (const pick of picks) {
        const live = open.filter((lane) => lane.length > 0);
        body.push(live[pick % live.length]!.shift()!);
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
        events: body.map((event, index): MaintenanceProgress => ({ ...event, operationId: "op", profileId: "one", seq: index + 1 })),
        summary
      };
    });
  })
  // The reloaded page subscribes after `subscribedAt` events have gone by
  // unheard. Main takes its snapshot after `snapshotAt`: no earlier, since
  // the page asks only once subscribed; before `finished`, or main would
  // answer with the receipt instead.
  .chain(({ events, summary }) =>
    fc.nat({ max: events.length - 1 }).chain((subscribedAt) =>
      fc.integer({ min: subscribedAt, max: events.length - 1 }).map((snapshotAt) => ({ events, summary, subscribedAt, snapshotAt }))
    )
  );

afterEach(() => vi.resetAllMocks());

describe("reattaching to a maintenance run", () => {
  // The rule: a window that reloads anywhere in a run, and hears main's
  // answer anywhere among the live events, ends up drawing exactly what a
  // window that watched from the start draws, and sees the receipt once.
  // The scheduler also lands the answer before events the snapshot already
  // holds, which ordered IPC does not do; the attach must not care.
  it("draws the same run as a window that watched it all, wherever the reload lands", async () => {
    await fc.assert(
      fc.asyncProperty(emittedRun, fc.scheduler(), async ({ events, summary, subscribedAt, snapshotAt }, s) => {
        vi.resetAllMocks();
        // Oracle: a window that heard every event from the start.
        const watched = events.slice(0, -1).reduce(foldMaintenanceProgress, EMPTY_MAINTENANCE_RUN_VIEW);
        const snapshot = events.slice(0, snapshotAt).reduce(foldMaintenanceProgress, EMPTY_MAINTENANCE_RUN_VIEW);
        let hear: ((event: MaintenanceProgress) => void) | null = null;
        subscribe.mockImplementation((_name: string, listener: (event: MaintenanceProgress) => void) => {
          hear = listener;
          return () => {
            hear = null;
          };
        });
        dispatch.mockImplementation((name: string) =>
          name === "maintenance:current"
            ? s.schedule(Promise.resolve({ ok: true, value: { state: "running", run, view: snapshot } as MaintenanceCurrent }), "answer")
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
        // Live events arrive in order; the answer lands wherever the
        // scheduler puts it among them.
        const delivered = s.scheduleSequence(
          events.slice(subscribedAt).map((event) => ({
            label: `event ${event.seq}`,
            builder: async () => (hear as ((e: MaintenanceProgress) => void) | null)?.(event)
          }))
        );
        await s.waitFor(delivered.task);
        await s.waitAll();
        expect(drawn).toEqual(watched);
        expect(finished).toEqual([summary]);
        expect(dispatch).toHaveBeenCalledWith("maintenance:seen", { profileId: "one", operationId: "op" });
        expect(hear).toBeNull();
      })
    );
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
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith("maintenance:current", { profileId: "one" }));
    await Promise.resolve();
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
