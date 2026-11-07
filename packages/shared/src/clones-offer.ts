/**
 * The one-time offer to run Maintenance › Clones, per profile: a background
 * dry run (`git worktree reflink -n`) estimates what sharing would save, and
 * if that is worth saying, one toast says it — once.
 * Design: `design/Clones in Maintenance - UX Review.dc.html`, turn 2.
 */

/** One linked worktree's dry run, as the estimate needs it. */
export type ClonesDryRun =
  | {
      kind: "measured";
      /** Git's `potential-private-reduction`: file data that would stop
       *  being private. */
      bytes: number;
      /** Files the dry run would share (`eligible`). */
      eligible: number;
      /** Some files' allocation was unknown, so `bytes` is a floor. */
      partial: boolean;
    }
  /** Git ran but could not size anything (another filesystem). */
  | { kind: "unmeasured"; eligible: number }
  /** Git failed, or answered with no summary. */
  | { kind: "failed" };

export type ClonesEstimate = {
  /** Dry runs attempted. */
  worktrees: number;
  measured: number;
  unmeasured: number;
  failed: number;
  /** Sum of `bytes` over measured worktrees: never a guess for the rest. */
  bytes: number;
  /** Eligible files across every worktree that answered. */
  eligibleFiles: number;
  /** Eligible files in worktrees with no byte figure. */
  unmeasuredFiles: number;
  /** A worktree reported only part of its allocation. */
  partial: boolean;
};

export const EMPTY_CLONES_ESTIMATE: ClonesEstimate = {
  worktrees: 0,
  measured: 0,
  unmeasured: 0,
  failed: 0,
  bytes: 0,
  eligibleFiles: 0,
  unmeasuredFiles: 0,
  partial: false
};

/** Add one worktree's dry run to an estimate. Order never matters. */
export function addClonesDryRun(estimate: ClonesEstimate, run: ClonesDryRun): ClonesEstimate {
  const next = { ...estimate, worktrees: estimate.worktrees + 1 };
  switch (run.kind) {
    case "failed":
      return { ...next, failed: next.failed + 1 };
    case "unmeasured":
      return {
        ...next,
        unmeasured: next.unmeasured + 1,
        eligibleFiles: next.eligibleFiles + run.eligible,
        unmeasuredFiles: next.unmeasuredFiles + run.eligible
      };
    case "measured":
      return {
        ...next,
        measured: next.measured + 1,
        bytes: next.bytes + run.bytes,
        eligibleFiles: next.eligibleFiles + run.eligible,
        partial: next.partial || run.partial
      };
  }
}

export function foldClonesEstimate(runs: readonly ClonesDryRun[]): ClonesEstimate {
  return runs.reduce(addClonesDryRun, EMPTY_CLONES_ESTIMATE);
}

/** A projected saving below this is not worth interrupting anyone for. */
export const CLONES_OFFER_MIN_BYTES = 512 * 1024 * 1024;
/** With no byte figure at all, this many shareable files still is. */
export const CLONES_OFFER_MIN_FILES = 500;

export type ClonesOffer =
  /** `atLeast`: some worktrees had no figure, or only part of one. */
  | { kind: "bytes"; bytes: number; atLeast: boolean }
  /** Git could not size anything; the copy names files, not bytes. */
  | { kind: "files"; files: number };

export type ClonesScanVerdict =
  | { kind: "offer"; offer: ClonesOffer }
  | { kind: "no_offer" }
  /** Not enough was learned: no worktree, or dry runs failed and what the
   *  rest found is no reason to offer. Scan again on a later launch rather
   *  than record a verdict the failed worktrees could overturn. */
  | { kind: "retry" };

export function clonesScanVerdict(estimate: ClonesEstimate): ClonesScanVerdict {
  if (estimate.worktrees === 0 || estimate.failed === estimate.worktrees) return { kind: "retry" };
  if (estimate.measured > 0 && estimate.bytes >= CLONES_OFFER_MIN_BYTES)
    return {
      kind: "offer",
      offer: {
        kind: "bytes",
        bytes: estimate.bytes,
        atLeast: estimate.partial || estimate.unmeasured > 0 || estimate.failed > 0
      }
    };
  if (estimate.unmeasuredFiles >= CLONES_OFFER_MIN_FILES)
    return { kind: "offer", offer: { kind: "files", files: estimate.eligibleFiles } };
  return estimate.failed > 0 ? { kind: "retry" } : { kind: "no_offer" };
}

/** What a profile remembers. Any record at all means: never scan again. */
export type ClonesOfferRecord = "no_offer" | "offered" | "accepted" | "dismissed";

export function isClonesOfferRecord(value: unknown): value is ClonesOfferRecord {
  return value === "no_offer" || value === "offered" || value === "accepted" || value === "dismissed";
}

/** Scan only a profile with no record, on a Git that can re-share. */
export function shouldScanClones(stored: ClonesOfferRecord | null, canReshare: boolean): boolean {
  return stored === null && canReshare;
}

/** A scan's verdict, against what the profile already holds: what to store
 *  and whether to show the toast. Offering is the one-time event. */
export function clonesOfferNext(
  stored: ClonesOfferRecord | null,
  verdict: ClonesScanVerdict
): { store: ClonesOfferRecord | null; show: ClonesOffer | null } {
  if (stored !== null || verdict.kind === "retry") return { store: null, show: null };
  if (verdict.kind === "no_offer") return { store: "no_offer", show: null };
  return { store: "offered", show: verdict.offer };
}

/** The toast's answer. Only an offer standing open takes one. */
export function clonesOfferAnswered(
  stored: ClonesOfferRecord | null,
  answer: "accepted" | "dismissed"
): ClonesOfferRecord | null {
  return stored === "offered" ? answer : stored;
}
