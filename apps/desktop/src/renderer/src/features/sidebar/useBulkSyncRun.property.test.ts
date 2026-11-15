import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Repo } from "@pwrgit/shared";
import {
  acceptBulkSyncProgress,
  nextBulkSyncRun,
  type BulkSyncRun
} from "./useBulkSyncRun";
import { countOutcomes, type BulkSyncLiveProgress } from "./bulk-sync-progress";

const repo = (id: string): Repo => ({
  id,
  name: id,
  path: `/repos/${id}`,
  profileId: "p",
  pinned: false,
  worktrees: []
});
const repos = [repo("a"), repo("b"), repo("c")];

const view = fc.constantFrom("dialog", "toast", "hidden") as fc.Arbitrary<
  BulkSyncRun["view"]
>;
const remembered = fc.constantFrom("dialog", "toast", null) as fc.Arbitrary<
  "dialog" | "toast" | null
>;

const liveRun = fc.record({
  key: fc.nat(1000),
  mode: fc.constantFrom("fetch", "soft-pull") as fc.Arbitrary<BulkSyncRun["mode"]>,
  scope: fc.constantFrom("all", "recent") as fc.Arbitrary<BulkSyncRun["scope"]>,
  view,
  autoMinimize: fc.boolean(),
  auto: fc.boolean()
}).map((r): BulkSyncRun => ({ ...r, repos, finished: false }));

const request = (over: { auto: boolean; remembered: "dialog" | "toast" | null; key: number }) => ({
  mode: "soft-pull" as const,
  scope: "recent" as const,
  repos,
  recentRepos: repos,
  ...over
});

/**
 * The rule the operator hit: the sync button's hover card said "click to
 * watch", and the click opened the remembered view (a toast) or, on a run
 * already in a toast, did nothing. A click on the face during a live run
 * must always end in the dialog, and never start a second run.
 * design/Sync Progress on the Button - UX Review.dc.html, 3a.
 */
describe("a click on the face during a live run", () => {
  it("shows that run in the dialog, whatever view it was in or was remembered", () => {
    fc.assert(
      fc.property(liveRun, remembered, fc.nat(1000), (current, rememberedView, key) => {
        const next = nextBulkSyncRun(current, request({ auto: false, remembered: rememberedView, key }));
        expect(next).not.toBeNull();
        expect(next!.key).toBe(current.key);
        expect(next!.finished).toBe(false);
        expect(next!.view).toBe("dialog");
        expect(next!.autoMinimize).toBe(false);
      })
    );
  });

  it("is left alone by a timed tick", () => {
    fc.assert(
      fc.property(liveRun, remembered, fc.nat(1000), (current, rememberedView, key) => {
        expect(
          nextBulkSyncRun(current, request({ auto: true, remembered: rememberedView, key }))
        ).toBe(current);
      })
    );
  });
});

const progress = fc
  .record({
    success: fc.nat(20),
    failed: fc.nat(5),
    inFlight: fc.nat(4),
    queued: fc.nat(20)
  })
  .map(
    (p): BulkSyncLiveProgress => ({
      counts: { ...countOutcomes([]), success: p.success, failed: p.failed },
      inFlight: p.inFlight,
      queued: p.queued,
      startedAt: 0,
      path: null
    })
  );

/**
 * Every surface (face, hover card, menu hint) reads one progress value. It
 * must belong to the run on screen: a report from an earlier run's dialog,
 * still unmounting, or one that arrives after the run finished, never shows.
 */
describe("the progress every surface reads", () => {
  it("is the newest report from the live run, and nothing else", () => {
    const step = fc.record({
      kind: fc.constantFrom("report", "report-stale", "start", "finish"),
      progress
    });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        let run: BulkSyncRun | null = null;
        let held: { key: number; progress: BulkSyncLiveProgress } | null = null;
        let expected: BulkSyncLiveProgress | null = null;
        let key = 0;
        for (const s of steps) {
          if (s.kind === "start") {
            key += 1;
            run = { key, mode: "fetch", scope: "all", repos, view: "hidden", autoMinimize: false, auto: true, finished: false };
            expected = null;
          } else if (s.kind === "finish") {
            if (run !== null) run = { ...(run as BulkSyncRun), finished: true };
            expected = null;
          } else if (s.kind === "report") {
            if (run !== null) {
              held = acceptBulkSyncProgress(held, run, run.key, s.progress);
              if (!run.finished) expected = s.progress;
            }
          } else {
            held = acceptBulkSyncProgress(held, run, key - 1, s.progress);
          }
          const shown =
            run !== null && !run.finished && held?.key === run.key ? held.progress : null;
          expect(shown).toBe(expected);
        }
      })
    );
  });
});
