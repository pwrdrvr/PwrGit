import type { RemoteResetMode, RemoteResetPreview } from "@pwrgit/shared";
import {
  rewrittenCommitCount,
  strandedCommitCount
} from "./CommitAlignment";

/**
 * What a reviewed reset actually costs, counted rather than described.
 *
 * The dialog used to explain Git's reachability rules in prose and show two
 * object names. Both are true and neither answers the question the user is
 * holding — how much of my work does this throw away — which the app can
 * answer exactly.
 */
export type ResetImpact = {
  /** Commits on the branch the target does not contain. */
  leaving: number;
  /**
   * Leaving commits with no counterpart on the target. These are the only ones
   * the target does not already carry in some form, so they are the number the
   * warning copy is allowed to raise its voice about.
   */
  stranded: number;
  /**
   * Leaving commits Git matched to a commit on the target — the same work
   * under a new object name, which is what a rebase and force-push upstream
   * looks like from here. Counting these as loss cries wolf on the most
   * common reason anyone opens this dialog.
   */
  rewritten: number;
  /** Commits on the target the branch does not contain. */
  arriving: number;
  /** Working-tree entries a hard reset is weighed against; 0 for soft. */
  discarding: number;
  /**
   * Whether to make the user confirm the loss explicitly. Only a hard reset
   * takes the content with it: a soft reset moves the pointer and leaves the
   * leaving commits' changes in the working tree as differences against the
   * new HEAD, so the same stranded count is not the same decision.
   */
  needsAcknowledgement: boolean;
};

export function resetImpact(
  preview: RemoteResetPreview,
  mode: RemoteResetMode
): ResetImpact {
  const stranded = strandedCommitCount(preview.alignedCommits);
  return {
    leaving: preview.leaving.length,
    stranded,
    rewritten: rewrittenCommitCount(preview.alignedCommits),
    arriving: preview.arriving.length,
    discarding: mode === "hard" ? preview.dirty : 0,
    needsAcknowledgement: mode === "hard" && stranded > 0
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A fetch age at the resolution the decision needs.
 *
 * `relativeAge` is day-grained, which is the right answer beside a branch name
 * and the wrong one here: "today" and "four minutes ago" are the difference
 * between resetting to the tip your colleague just pushed and resetting to the
 * one they replaced this morning.
 */
export function fetchAgeLabel(iso: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "at an unknown time";
  if (elapsed < MINUTE_MS) return "moments ago";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}h ago` : `${hours}h ${minutes}m ago`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `${days}d ago`;
}

/** Past this, the fetched view is old enough to say so rather than just date it. */
export const STALE_FETCH_MS = 15 * MINUTE_MS;

export function isStaleFetch(iso: string | null, now: number = Date.now()): boolean {
  if (iso === null) return true;
  const at = Date.parse(iso);
  return !Number.isFinite(at) || now - at > STALE_FETCH_MS;
}

/**
 * What resetting to a ranked target would do, in one line.
 *
 * The card already prints the raw arrows; this says what they mean, and has to
 * stay right at the edges — "It has 0 commits yours does not" is what a
 * template that only knows how to describe divergence says about a branch that
 * is already identical.
 */
export function targetNote(ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) return "Already identical to this branch.";
  if (ahead === 0) {
    return `Fast-forward: ${commits(behind)} ${verb(behind, "arrive")}, none of yours leave.`;
  }
  if (behind === 0) {
    return `${commits(ahead)} of yours ${verb(ahead, "leave")} the branch; nothing arrives.`;
  }
  return `Diverged: ${commits(ahead)} of yours leave, ${behind} arrive.`;
}

const commits = (count: number): string =>
  `${count} commit${count === 1 ? "" : "s"}`;

const verb = (count: number, plural: string): string =>
  count === 1 ? `${plural}s` : plural;

/** Short display name for a fully-qualified remote-tracking ref. */
export function remoteRefLabel(ref: string): string {
  return ref.startsWith("refs/remotes/")
    ? ref.slice("refs/remotes/".length)
    : ref;
}
