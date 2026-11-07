import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLONES_OFFER_MIN_BYTES,
  CLONES_OFFER_MIN_FILES,
  clonesOfferAnswered,
  clonesOfferNext,
  clonesScanVerdict,
  foldClonesEstimate,
  shouldScanClones,
  type ClonesDryRun,
  type ClonesOffer,
  type ClonesOfferRecord
} from "./clones-offer";

const GIB = 1024 * 1024 * 1024;
/** Sizes around the threshold, not only far from it. */
const bytes = fc.oneof(
  fc.integer({ min: 0, max: 8 * GIB }),
  fc.integer({ min: CLONES_OFFER_MIN_BYTES - 2, max: CLONES_OFFER_MIN_BYTES + 2 })
);
const files = fc.oneof(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: CLONES_OFFER_MIN_FILES - 2, max: CLONES_OFFER_MIN_FILES + 2 }));
const dryRun: fc.Arbitrary<ClonesDryRun> = fc.oneof(
  fc.record({ kind: fc.constant("measured" as const), bytes, eligible: files, partial: fc.boolean() }),
  fc.record({ kind: fc.constant("unmeasured" as const), eligible: files }),
  fc.constant({ kind: "failed" as const })
);
const dryRuns = fc.array(dryRun, { maxLength: 12 });

describe("the Clones estimate, for any set of dry runs", () => {
  it("sums Git's figure over measured worktrees only, whatever their order", () => {
    fc.assert(
      fc.property(dryRuns, fc.func(fc.integer()), (runs, key) => {
        const estimate = foldClonesEstimate(runs);
        const measured = runs.filter((run) => run.kind === "measured");
        expect(estimate.bytes).toBe(measured.reduce((sum, run) => sum + run.bytes, 0));
        expect(estimate.worktrees).toBe(runs.length);
        expect(estimate.measured + estimate.unmeasured + estimate.failed).toBe(runs.length);
        expect(estimate.partial).toBe(measured.some((run) => run.partial));
        const shuffled = [...runs].sort((a, b) => key(a) - key(b));
        expect(foldClonesEstimate(shuffled)).toEqual(estimate);
      })
    );
  });

  it("offers a number only when Git measured that much, and says 'at least' exactly when some went unmeasured", () => {
    fc.assert(
      fc.property(dryRuns, (runs) => {
        const estimate = foldClonesEstimate(runs);
        const verdict = clonesScanVerdict(estimate);
        const learned = runs.some((run) => run.kind !== "failed");
        if (!learned) expect(verdict.kind).toBe("retry");
        // A failed dry run never lets a "no" be written down for good.
        if (estimate.failed > 0) expect(verdict.kind).not.toBe("no_offer");
        if (verdict.kind !== "offer") {
          if (learned) {
            expect(estimate.bytes < CLONES_OFFER_MIN_BYTES || estimate.measured === 0).toBe(true);
            expect(estimate.unmeasuredFiles).toBeLessThan(CLONES_OFFER_MIN_FILES);
          }
          return;
        }
        const offer = verdict.offer;
        if (offer.kind === "bytes") {
          expect(offer.bytes).toBe(estimate.bytes);
          expect(offer.bytes).toBeGreaterThanOrEqual(CLONES_OFFER_MIN_BYTES);
          expect(offer.atLeast).toBe(
            runs.some((run) => run.kind !== "measured" || run.partial)
          );
        } else {
          // No byte figure is ever invented: the files offer comes only from
          // worktrees Git could not size.
          expect(estimate.bytes < CLONES_OFFER_MIN_BYTES || estimate.measured === 0).toBe(true);
          expect(estimate.unmeasuredFiles).toBeGreaterThanOrEqual(CLONES_OFFER_MIN_FILES);
          expect(offer.files).toBe(estimate.eligibleFiles);
        }
      })
    );
  });
});

/** One app launch for a profile: the Git in use, what the dry runs found,
 *  and what the reader did with a toast if one was up. */
type Launch = {
  canReshare: boolean;
  runs: ClonesDryRun[];
  answer: "accepted" | "dismissed" | "ignored";
};
const launch: fc.Arbitrary<Launch> = fc.record({
  canReshare: fc.boolean(),
  runs: dryRuns,
  answer: fc.constantFrom("accepted" as const, "dismissed" as const, "ignored" as const)
});

describe("the one-time offer, across any sequence of launches", () => {
  it("shows at most one toast, decides once, and never forgets", () => {
    fc.assert(
      fc.property(fc.array(launch, { maxLength: 12 }), (launches) => {
        let stored: ClonesOfferRecord | null = null;
        const shown: ClonesOffer[] = [];
        let decidedAt: number | null = null;
        launches.forEach((step, index) => {
          const before = stored;
          let shownNow = false;
          if (shouldScanClones(stored, step.canReshare)) {
            const next = clonesOfferNext(stored, clonesScanVerdict(foldClonesEstimate(step.runs)));
            if (next.store !== null) stored = next.store;
            if (next.show !== null) {
              shown.push(next.show);
              shownNow = true;
            }
          }
          // The only answer is to a toast standing on screen.
          if (shownNow && step.answer !== "ignored") stored = clonesOfferAnswered(stored, step.answer);
          // A Git that cannot share never scans, so it never decides.
          if (!step.canReshare) expect(stored).toBe(before);
          // Nothing undoes a decision.
          if (before !== null) expect(stored).not.toBeNull();
          if (before === null && stored !== null) decidedAt = index;
          // After the decision, a launch never changes the record — the
          // toast's own answer on its launch aside.
          if (decidedAt !== null && decidedAt < index) expect(stored).toBe(before);
        });
        expect(shown.length).toBeLessThanOrEqual(1);
        if (shown.length === 1) expect(["offered", "accepted", "dismissed"]).toContain(stored);
      })
    );
  });

  it("records an answer only for an offer standing open", () => {
    const records: (ClonesOfferRecord | null)[] = [null, "no_offer", "offered", "accepted", "dismissed"];
    for (const stored of records)
      for (const answer of ["accepted", "dismissed"] as const)
        expect(clonesOfferAnswered(stored, answer)).toBe(stored === "offered" ? answer : stored);
  });

  it("a stored record, of any kind, never scans again", () => {
    for (const stored of ["no_offer", "offered", "accepted", "dismissed"] as const) {
      expect(shouldScanClones(stored, true)).toBe(false);
      expect(clonesOfferNext(stored, { kind: "offer", offer: { kind: "files", files: 9_999 } })).toEqual({ store: null, show: null });
    }
  });
});
