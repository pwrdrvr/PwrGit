import {
  clonesOfferAnswered,
  clonesOfferNext,
  clonesScanVerdict,
  err,
  foldClonesEstimate,
  isClonesOfferRecord,
  ok,
  shouldScanClones,
  type ClonesDryRun,
  type ClonesEstimate,
  type ClonesOffer,
  type ClonesOfferRecord
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { mapLimit } from "../util/map-limit";
import type { GitExec } from "./dugite";
import { activeGitReflinkProbe } from "./dugite";
import { visibleRepoSql } from "./hidden-repos";
import { refreshActiveGitReflink } from "./runtime-status";
import type { WorktreeOperationQueue } from "./worktree-operation-queue";
import { dryRunWorktreeClones, RESHARE_WORKTREE_CONCURRENCY } from "./worktree-reshare";

/** `profile_notices.notice` for the Clones offer. */
export const CLONES_OFFER_NOTICE = "clones_offer";

export function readClonesOfferRecord(db: DB, profileId: string): ClonesOfferRecord | null {
  const row = db
    .prepare("SELECT state FROM profile_notices WHERE profile_id = ? AND notice = ?")
    .get(profileId, CLONES_OFFER_NOTICE) as { state: string } | undefined;
  // An unknown state is still a record: whatever wrote it already decided.
  if (row === undefined) return null;
  return isClonesOfferRecord(row.state) ? row.state : "no_offer";
}

export function writeClonesOfferRecord(db: DB, profileId: string, state: ClonesOfferRecord, now: number): void {
  db.prepare(
    `INSERT INTO profile_notices (profile_id, notice, state, updated_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, notice) DO UPDATE SET state = excluded.state, updated_at_ms = excluded.updated_at_ms`
  ).run(profileId, CLONES_OFFER_NOTICE, state, now);
}

/** The linked worktrees a Clones run would visit for this profile: its
 *  shown repositories, without missing or Git-locked checkouts. */
function scannableWorktrees(db: DB, profileId: string): Array<{ id: string; path: string }> {
  return db
    .prepare(
      `SELECT w.id, w.path FROM worktrees w JOIN repos r ON r.id = w.repo_id
       WHERE r.profile_id = ? AND ${visibleRepoSql("r")}
         AND w.is_primary = 0 AND w.missing = 0 AND w.locked = 0
       ORDER BY r.name COLLATE NOCASE, w.path`
    )
    .all(profileId) as Array<{ id: string; path: string }>;
}

/** Dry-run every linked worktree in the profile, two at a time, each under
 *  its worktree lock as the real run takes it. */
export async function estimateProfileClones(
  db: DB,
  git: GitExec,
  operations: Pick<WorktreeOperationQueue, "run">,
  profileId: string
): Promise<ClonesEstimate> {
  const worktrees = scannableWorktrees(db, profileId);
  const runs = await mapLimit(worktrees, RESHARE_WORKTREE_CONCURRENCY, (worktree) =>
    // A worktree removed mid-scan is one failed dry run, not a failed scan.
    operations
      .run(worktree.id, () => dryRunWorktreeClones(git, worktree.path))
      .catch((): ClonesDryRun => ({ kind: "failed" }))
  );
  return foldClonesEstimate(runs);
}

export function registerClonesOfferHandlers(
  bus: CommandBus,
  db: DB,
  git: GitExec,
  operations: Pick<WorktreeOperationQueue, "run">,
  now: () => number = Date.now,
  /** Whether the Git in use has `git worktree reflink`. */
  canReshare: () => Promise<boolean> = async () => {
    if (activeGitReflinkProbe() === null) await refreshActiveGitReflink();
    return activeGitReflinkProbe()?.support.reshare === true;
  }
): void {
  /** A profile being scanned now. A second ask (two windows, a reload) gets
   *  null rather than a second scan, so at most one toast is raised. */
  const scanning = new Set<string>();
  const profileExists = (profileId: string): boolean =>
    db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(profileId) !== undefined;

  bus.register("maintenance:clonesOffer", async (req) => {
    const profileId = typeof req?.profileId === "string" ? req.profileId : "";
    if (!profileExists(profileId))
      return err({ kind: "profile", code: "not_found", message: "This profile no longer exists." });
    if (scanning.has(profileId) || readClonesOfferRecord(db, profileId) !== null) return ok(null);
    scanning.add(profileId);
    try {
      if (!shouldScanClones(null, await canReshare())) return ok(null);
      const estimate = await estimateProfileClones(db, git, operations, profileId);
      const verdict = clonesScanVerdict(estimate);
      // Read again: nothing else writes while `scanning` holds the profile,
      // but the profile may have been deleted meanwhile.
      if (!profileExists(profileId)) return ok(null);
      const next = clonesOfferNext(readClonesOfferRecord(db, profileId), verdict);
      if (next.store !== null) writeClonesOfferRecord(db, profileId, next.store, now());
      logMain(
        "info",
        "maintenance",
        `clones offer for profile ${profileId}: ${verdict.kind} · ${estimate.worktrees} worktrees, ` +
          `${estimate.measured} measured, ${estimate.failed} failed, ${estimate.bytes} bytes projected, ` +
          `${estimate.eligibleFiles} files`
      );
      return ok(next.show satisfies ClonesOffer | null);
    } finally {
      scanning.delete(profileId);
    }
  });

  bus.register("maintenance:clonesOfferAnswer", (req) => {
    const profileId = typeof req?.profileId === "string" ? req.profileId : "";
    if (req?.answer !== "accepted" && req?.answer !== "dismissed")
      return err({ kind: "validation", code: "invalid_answer", message: "Answer accepted or dismissed." });
    if (!profileExists(profileId)) return ok(null);
    const stored = readClonesOfferRecord(db, profileId);
    const next = clonesOfferAnswered(stored, req.answer);
    if (next !== null && next !== stored) writeClonesOfferRecord(db, profileId, next, now());
    return ok(null);
  });
}
