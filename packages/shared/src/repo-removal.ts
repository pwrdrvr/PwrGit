// Hiding and removing a repository.
//
// The decision rules live here, in shared, for the same reason `prunable.ts`
// does: the renderer draws the review and main re-checks it before anything
// is moved, and two copies of "what still needs a decision" would let the
// dialog enable a button that main then refuses — or worse, the other way
// round. design/Remove and Hide Repository - UX Review.dc.html is the review.

import type { ProfileId, RepoId, WorktreeId } from "./types";

/** One repository a profile has hidden. Keyed by path, not by repo row: a
 *  rescan can drop and recreate the row, and the folder can disappear. */
export type HiddenRepo = {
  profileId: ProfileId;
  profileName: string;
  /** The main checkout's path, as the scan indexed it. */
  path: string;
  name: string;
  /** ISO timestamp. */
  hiddenAt: string;
  /** The indexed repository behind the entry, while a scan still finds it. */
  repoId: RepoId | null;
  worktreeCount: number;
  /** Neither indexed nor on disk: moved or deleted, perhaps by another profile. */
  missing: boolean;
};

/** What the review concluded about one checkout. */
export type RemovalVerdict = "safe" | "at_risk" | "blocked";

/** The answer to an at-risk item. `push` is carried out by the renderer
 *  through the ordinary push commands before removal starts; main is only
 *  ever handed `keep` or `discard`. */
export type RemovalChoice = "push" | "keep" | "discard";

/** A Git operation stopped half way: nothing here will discard one. */
export type RemovalInProgress =
  | "rebase"
  | "merge"
  | "cherry-pick"
  | "revert"
  | "bisect";

/** One checkout of the repository: a linked worktree or the main checkout. */
export type RemovalCheckout = {
  worktreeId: WorktreeId;
  /** Branch name; empty for a detached HEAD. */
  branch: string;
  head: string;
  path: string;
  isPrimary: boolean;
  /** The folder is gone — possibly only on a volume that is not mounted. */
  missing: boolean;
  /** `git worktree lock`ed: someone asked for it to be left alone. */
  locked: boolean;
  /** Tracked files with changes, staged or not. */
  uncommitted: number;
  untracked: number;
  conflicted: number;
  /** Commits reachable from HEAD and from no remote-tracking ref. */
  unpushed: number;
  /** Short upstream name (`origin/main`), or null when none is configured. */
  upstream: string | null;
  inProgress: RemovalInProgress | null;
  /** Where Push first would go: the upstream's remote, else `origin`, else
   *  the only remote. Null when there is nowhere to push. */
  pushRemote: string | null;
  /** Apparent size of the folder, or null when it was not measured. */
  bytes: number | null;
  /** The walk stopped early, so `bytes` is a floor. */
  bytesPartial: boolean;
  /** Git could not inspect the checkout; treated as at risk. */
  inspectError: string | null;
};

/** A local branch nothing has checked out, holding commits on no remote. */
export type RemovalBranch = {
  name: string;
  unpushed: number;
  pushRemote: string | null;
};

export type RemovalStashes = {
  count: number;
  newestSubject: string | null;
  newestAt: string | null;
};

export type RepoRemovalReview = {
  repoId: RepoId;
  profileId: ProfileId;
  name: string;
  path: string;
  remotes: { name: string; url: string }[];
  /** Linked worktrees first, the main checkout last. */
  checkouts: RemovalCheckout[];
  stashes: RemovalStashes;
  branches: RemovalBranch[];
  reviewedAt: string;
};

/** The user's answers, keyed by worktree id and branch name. */
export type RemovalDecisions = {
  checkouts: Record<string, RemovalChoice>;
  stashes?: RemovalChoice;
  branches: Record<string, RemovalChoice>;
};

export function checkoutVerdict(checkout: RemovalCheckout): RemovalVerdict {
  if (checkout.locked || checkout.inProgress !== null) return "blocked";
  if (
    checkout.missing ||
    checkout.inspectError !== null ||
    checkout.uncommitted > 0 ||
    checkout.untracked > 0 ||
    checkout.conflicted > 0 ||
    checkout.unpushed > 0
  ) {
    return "at_risk";
  }
  return "safe";
}

/** Push first is offered only when unpushed commits are the ONLY risk: it
 *  would save the commits and lose everything else. */
export function canPushCheckout(checkout: RemovalCheckout): boolean {
  return (
    checkoutVerdict(checkout) === "at_risk" &&
    checkout.unpushed > 0 &&
    !checkout.missing &&
    checkout.inspectError === null &&
    checkout.uncommitted === 0 &&
    checkout.untracked === 0 &&
    checkout.conflicted === 0 &&
    checkout.branch !== "" &&
    checkout.pushRemote !== null
  );
}

/** The answers a checkout may be given. Safe needs none; blocked can only be
 *  kept, because the dialog cannot describe a half-applied operation. */
export function checkoutChoices(checkout: RemovalCheckout): RemovalChoice[] {
  switch (checkoutVerdict(checkout)) {
    case "safe":
      return [];
    case "blocked":
      return ["keep"];
    case "at_risk":
      return canPushCheckout(checkout)
        ? ["push", "keep", "discard"]
        : ["keep", "discard"];
  }
}

export function branchChoices(branch: RemovalBranch): RemovalChoice[] {
  return branch.pushRemote === null
    ? ["keep", "discard"]
    : ["push", "keep", "discard"];
}

export type RemovalStatus = {
  /** At-risk items with no answer yet (that still matter). */
  undecided: number;
  /** Blocked checkouts not yet answered with Keep. */
  blocked: number;
  safe: number;
  /** The main checkout stays: something that depends on its `.git` is kept. */
  partial: boolean;
  /** Linked worktrees going to the Trash, or whose record is cleared. */
  removeWorktreeIds: WorktreeId[];
  removePrimary: boolean;
  /** Things the renderer pushes before removal starts. */
  pushWorktreeIds: WorktreeId[];
  pushBranches: string[];
  /** Plain-English list of what a Discard gives up, for the name gate. */
  discards: string[];
  /** A full removal that discards work: the repository's name is typed. */
  needsName: boolean;
  /** Every item is safe or decided and there is something to remove. */
  ready: boolean;
  /** Folders that will move, not counting checkouts already missing. */
  folderCount: number;
  bytes: number;
};

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

function checkoutLoss(checkout: RemovalCheckout): string {
  const label = checkout.branch === "" ? checkout.path : checkout.branch;
  // A missing folder's files are out of reach; its branch's commits are in
  // the main checkout's .git, counted by the review.
  if (checkout.missing) {
    return checkout.unpushed > 0
      ? `${plural(checkout.unpushed, "commit")} in ${label}`
      : `the record of ${label}`;
  }
  const parts: string[] = [];
  if (checkout.uncommitted > 0) parts.push(plural(checkout.uncommitted, "uncommitted file"));
  if (checkout.untracked > 0) parts.push(plural(checkout.untracked, "untracked file"));
  if (checkout.conflicted > 0) parts.push(plural(checkout.conflicted, "conflicted file"));
  if (checkout.unpushed > 0) parts.push(plural(checkout.unpushed, "commit"));
  if (parts.length === 0) return label;
  return `${parts.join(", ")} in ${label}`;
}

/**
 * Fold a review and its answers into what would happen. Main runs this again
 * on a fresh review before it moves anything, so a checkout that changed after
 * the dialog opened comes back undecided rather than being removed on an
 * answer given about a different state.
 */
export function removalStatus(
  review: RepoRemovalReview,
  decisions: RemovalDecisions
): RemovalStatus {
  const linked = review.checkouts.filter((c) => !c.isPrimary);
  const primary = review.checkouts.find((c) => c.isPrimary) ?? null;
  const choiceOf = (checkout: RemovalCheckout): RemovalChoice | undefined => {
    const choice = decisions.checkouts[checkout.worktreeId];
    return choice !== undefined && checkoutChoices(checkout).includes(choice)
      ? choice
      : undefined;
  };

  let undecided = 0;
  let blocked = 0;
  let safe = 0;
  const removeWorktreeIds: WorktreeId[] = [];
  const pushWorktreeIds: WorktreeId[] = [];
  const discards: string[] = [];
  let keptLinked = 0;

  for (const checkout of linked) {
    const verdict = checkoutVerdict(checkout);
    const choice = choiceOf(checkout);
    if (verdict === "safe") {
      safe += 1;
      removeWorktreeIds.push(checkout.worktreeId);
      continue;
    }
    if (choice === "keep") {
      keptLinked += 1;
      continue;
    }
    if (verdict === "blocked") {
      blocked += 1;
      continue;
    }
    if (choice === undefined) {
      undecided += 1;
      continue;
    }
    removeWorktreeIds.push(checkout.worktreeId);
    if (choice === "push") pushWorktreeIds.push(checkout.worktreeId);
    else discards.push(checkoutLoss(checkout));
  }

  // Everything below lives in the main checkout's .git: keeping any of it
  // keeps the main checkout, and a kept linked worktree needs that .git too.
  const primaryVerdict = primary === null ? "safe" : checkoutVerdict(primary);
  const primaryChoice = primary === null ? undefined : choiceOf(primary);
  const stashChoice =
    review.stashes.count > 0 &&
    decisions.stashes !== undefined &&
    decisions.stashes !== "push"
      ? decisions.stashes
      : undefined;
  const branchChoice = (branch: RemovalBranch): RemovalChoice | undefined => {
    const choice = decisions.branches[branch.name];
    return choice !== undefined && branchChoices(branch).includes(choice)
      ? choice
      : undefined;
  };
  const partial =
    keptLinked > 0 ||
    primaryChoice === "keep" ||
    stashChoice === "keep" ||
    review.branches.some((b) => branchChoice(b) === "keep");

  const pushBranches: string[] = [];
  let removePrimary = false;
  if (primary !== null && !partial) {
    if (primaryVerdict === "safe") safe += 1;
    else if (primaryVerdict === "blocked") blocked += 1;
    else if (primaryChoice === undefined) undecided += 1;
    else if (primaryChoice === "push") pushWorktreeIds.push(primary.worktreeId);
    else discards.push(checkoutLoss(primary));

    if (review.stashes.count > 0) {
      if (stashChoice === undefined) undecided += 1;
      else discards.push(plural(review.stashes.count, "stash", "stashes"));
    }
    for (const branch of review.branches) {
      const choice = branchChoice(branch);
      if (choice === undefined) undecided += 1;
      else if (choice === "push") pushBranches.push(branch.name);
      else discards.push(`${plural(branch.unpushed, "commit")} on ${branch.name}`);
    }
    removePrimary = true;
  }

  const removing = review.checkouts.filter(
    (c) =>
      removeWorktreeIds.includes(c.worktreeId) ||
      (c.isPrimary && removePrimary)
  );
  const present = removing.filter((c) => !c.missing);
  const ready =
    undecided === 0 && blocked === 0 && removing.length > 0;
  return {
    undecided,
    blocked,
    safe,
    partial,
    removeWorktreeIds,
    removePrimary,
    pushWorktreeIds,
    pushBranches,
    discards,
    needsName: removePrimary && discards.length > 0,
    ready,
    folderCount: present.length,
    bytes: present.reduce((sum, c) => sum + (c.bytes ?? 0), 0)
  };
}

/** One line of the running removal, streamed as it moves. */
export type RemovalStep = {
  id: string;
  kind: "trash" | "forget" | "delete";
  worktreeId: WorktreeId;
  label: string;
  path: string;
  isPrimary: boolean;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  message?: string;
};

export type RepoRemovalProgress = {
  operationId: string;
  profileId: ProfileId;
  repoId: RepoId;
  steps: RemovalStep[];
};

export type RepoRemovalResult = {
  /** `removed`: the repository is gone. `partial`: only worktrees went, as
   *  asked. `stopped`: a step failed and the main checkout was not touched. */
  outcome: "removed" | "partial" | "stopped";
  steps: RemovalStep[];
};
