import type {
  ForkPushBack,
  ForkSourceTarget,
  RemoteResetMode,
  RemoteResetPreview,
  ResetTargets,
  ResetTargetSuggestion
} from "@pwrgit/shared";
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

/** Whether resetting to this target would move the branch at all. */
const moves = (target: ResetTargetSuggestion | null): boolean =>
  target !== null && (target.ahead > 0 || target.behind > 0);

/**
 * The ranked card the dialog opens on.
 *
 * The tracked branch first, while resetting to it would change something.
 * Then the fork's source, because on a fork whose `origin/main` already
 * matches `main`, opening on the tracked branch offers the one reset that does
 * nothing, and buries the one the user came for behind a filter box. Then
 * whatever exists, identical or not: the trunk is never a guessed default for
 * a feature branch.
 */
export function rankedTarget(
  targets: ResetTargets
): ResetTargetSuggestion | null {
  if (moves(targets.upstream)) return targets.upstream;
  if (moves(targets.forkSource)) return targets.forkSource;
  return targets.upstream ?? targets.forkSource ?? targets.defaultBranch;
}

/** Every remote a ranked card was fetched from, the tracked one first. */
export function targetRemotes(targets: ResetTargets): string[] {
  const remotes = [targets.upstream, targets.forkSource, targets.defaultBranch]
    .filter((target): target is ResetTargetSuggestion => target !== null)
    .map((target) => target.remote);
  return [...new Set(remotes)];
}

/** "a", "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export type FetchCoverage = {
  text: string;
  stale: boolean;
  fetchLabel: string;
  /** What Fetch asks for; undefined is the branch's own remote, as before. */
  remotes: string[] | undefined;
};

/**
 * What the freshness strip says about the snapshot the reset reads from.
 *
 * With one remote in play this is the old sentence: `FETCH_HEAD`'s age. With a
 * fork's source in play the age is not enough. A bare fetch asks only the
 * branch's own remote, so "moments ago" was true of `origin` while the
 * `upstream/main` being reset to was 19 minutes behind the source — which is
 * exactly how a reported reset landed on a tip two merges out of date. So the
 * strip names the remotes `FETCH_HEAD` covered, warns when a card's remote is
 * missing from it, and Fetch asks every remote a card came from.
 */
export function fetchCoverage(
  targets: ResetTargets | null,
  now: number = Date.now()
): FetchCoverage {
  const fork = targets?.forkSource ?? null;
  const remotes =
    targets === null || fork === null ? undefined : targetRemotes(targets);
  if (targets?.lastFetchedAt == null) {
    return {
      text: "This repository has not fetched in this session — the refs below may be old.",
      stale: true,
      fetchLabel: remotes === undefined ? "Fetch now" : `Fetch ${remotes.join(" + ")}`,
      remotes
    };
  }
  const age = fetchAgeLabel(targets.lastFetchedAt, now);
  const old = isStaleFetch(targets.lastFetchedAt, now);
  if (remotes === undefined || fork === null) {
    return {
      text: `Last fetched ${age} — the reset uses that snapshot, not the live remote.`,
      stale: old,
      fetchLabel: "Fetch now",
      remotes
    };
  }
  const covered = remotes.filter((remote) =>
    targets.lastFetchedRemotes.includes(remote)
  );
  const missing = remotes.filter((remote) => !covered.includes(remote));
  if (missing.length === 0) {
    return {
      text: `Last fetched ${age} from ${andList(remotes)} — the reset uses that snapshot, not the live remotes.`,
      stale: old,
      fetchLabel: "Fetch now",
      remotes
    };
  }
  const outdated = [targets.upstream, fork, targets.defaultBranch]
    .filter(
      (target): target is ResetTargetSuggestion =>
        target !== null && missing.includes(target.remote)
    )
    .map((target) => target.label);
  const onlyFork =
    outdated.length === 1 && outdated[0] === fork.label && fork.parent !== undefined;
  const behind = onlyFork
    ? `may be behind ${fork.parent}`
    : "may be out of date";
  const lead =
    covered.length === 0
      ? `The last fetch, ${age}, did not include ${andList(missing)}.`
      : `The last fetch, ${age}, covered ${andList(covered)} only.`;
  return {
    text: `${lead} ${andList(outdated)} ${behind}.`,
    stale: true,
    fetchLabel: `Fetch ${remotes.join(" + ")}`,
    remotes
  };
}

/** The push the fork-source card offers, when it is the selected target. */
export function forkPushPlan(
  fork: ForkSourceTarget | null,
  selectedRef: string | undefined
): ForkPushBack | null {
  if (fork === null || selectedRef !== fork.ref) return null;
  return fork.pushBack;
}

/** Whether the push has to force, and so removes commits from the remote. */
export const pushForces = (plan: ForkPushBack): boolean => plan.overwrites > 0;

/** One line under the push checkbox: what it adds, or what it removes. */
export function pushNote(
  plan: ForkPushBack,
  fork: ResetTargetSuggestion,
  branch: string
): string {
  const tracked = `${plan.remote}/${plan.branch}`;
  if (!pushForces(plan)) {
    return `After the reset, push ${branch} to ${tracked}: the same ${commits(plan.adds)}, no force needed.`;
  }
  return `${tracked} has ${commits(plan.overwrites)} that ${fork.label} doesn't, and pushing removes ${plan.overwrites === 1 ? "it" : "them"} from ${plan.remote}. The lease refuses the push if ${tracked} has moved off ${plan.head.slice(0, 12)}.`;
}
