import type { RepoRefs, WorktreeId } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import { holderWorktreeId, isBranchSentinel } from "../sidebar/branch-focus";
import { nudgeToCommit } from "./commitNudge";
import { chooseDialog } from "./dialogs";

/**
 * The guarded checkout every branch-switch entry point goes through.
 *
 * `git switch` *succeeds* with uncommitted changes when they do not conflict,
 * carrying them onto the new branch. Sometimes that is exactly what you want;
 * sometimes it silently scatters work across branches, and from a branch row
 * the user cannot tell which. So the switch is gated on the destination
 * worktree's dirtiness rather than attempted blind.
 *
 * The gate deliberately does NOT consider the main process's operation queue.
 * `WorktreeOperationQueue` serializes a scope without blocking unrelated ones
 * and exposes no busy state; `branch:switch` already runs inside it. A switch
 * requested while a pull is in flight should queue behind the pull, not be
 * refused.
 */

export type DirtyState =
  /** A fresh snapshot says the tree is clean. */
  | { kind: "clean" }
  | { kind: "dirty"; files: number }
  /** No snapshot could be read. Treated exactly like dirty — see below. */
  | { kind: "unknown" }
  /** The checkout is gone: there is nothing to switch, and nothing to carry
   *  over, so the switch is refused outright rather than confirmed. */
  | { kind: "missing"; message: string };

/**
 * Read checkout safety directly from Git rather than trusting a cached coarse
 * snapshot. The main-process probe includes dirty initialized submodules and
 * shares the worktree operation queue with mutations.
 */
export async function readDirtyState(
  worktreeId: WorktreeId
): Promise<DirtyState> {
  const result = await dispatch("worktree:readDirty", { worktreeId });
  if (!result.ok) {
    return result.error.code === "worktree_missing"
      ? { kind: "missing", message: result.error.message }
      : { kind: "unknown" };
  }
  return result.value.dirty > 0
    ? { kind: "dirty", files: result.value.dirty }
    : { kind: "clean" };
}

/** The prompt's body. Named separately so the wording is testable without a
 *  dialog host, and so every entry point says the same thing. */
export function dirtySwitchMessage(
  dirty: DirtyState,
  worktreeLabel: string,
  branch: string
): string {
  const changes =
    dirty.kind === "dirty"
      ? `${dirty.files} uncommitted ${dirty.files === 1 ? "change" : "changes"}`
      : "uncommitted changes PwrGit could not count";
  return `${worktreeLabel} has ${changes}, and ${branch} is a different branch. What did you mean to do with them?`;
}

/** What the reader said the uncommitted work was for. */
export type DirtyIntent = "carry" | "commit_first" | "cancel";

/**
 * Ask what the uncommitted work is for, rather than assuming.
 *
 * PwrGit used to offer one answer — "Carry changes over" — against Cancel,
 * which made a two-button dialog out of a question with three real answers.
 * Worse, it named the *mechanism* (`git switch` carries non-conflicting changes)
 * instead of the intent, so the reader had to already know git's behaviour to
 * know what the button would do, and the answer "these belong on the branch I am
 * leaving" had nowhere to go but Cancel.
 *
 * `commit_first` deliberately performs no git at all. Committing is a decision
 * with a message attached; making it from a modal that is really about
 * switching would be a worse place to write one than the commit box the rail
 * already has.
 */
export async function askDirtyIntent(
  dirty: DirtyState,
  worktreeLabel: string,
  fromBranch: string,
  branch: string,
  facts: string[] = []
): Promise<DirtyIntent> {
  // `branch-focus` owns the rule for which `Worktree.branch` values are not
  // branch names — a second copy here would drift the first time a sentinel is
  // added, and print it at the reader as though it were a branch.
  const here =
    fromBranch !== "" && !isBranchSentinel(fromBranch)
      ? fromBranch
      : "this checkout";
  const answer = await chooseDialog({
    title: `Switch to ${branch}?`,
    message: dirtySwitchMessage(dirty, worktreeLabel, branch),
    facts,
    choices: [
      {
        id: "carry",
        label: `Bring them to ${branch}`,
        detail: `PwrGit saves them, switches, and restores them on ${branch}. If they cannot be applied there, nothing moves — you stay on ${here} with them untouched.`
      },
      {
        id: "commit_first",
        label: `Commit on ${here} first`,
        detail: "Stays here and opens the commit box. Nothing is switched."
      }
    ],
    cancelLabel: "Cancel"
  });
  if (answer === "carry") return "carry";
  if (answer === "commit_first") return "commit_first";
  return "cancel";
}

/** The handful of paths the prompt lists, so "7 changes" is something the
 *  reader can actually judge. Best-effort: a failed read costs the list, not
 *  the prompt. */
export async function dirtyFacts(
  worktreeId: WorktreeId,
  limit = 5
): Promise<string[]> {
  const result = await dispatch("changes:list", { worktreeId });
  if (!result.ok) return [];
  const { staged, unstaged, truncated } = result.value;
  const unique = [
    ...new Set([
      ...staged.map((file) => file.path),
      ...unstaged.map((file) => file.path)
    ])
  ];
  // `changes:list` caps its rows and reports the real totals separately, so a
  // remainder counted off the returned array undercounts exactly when it
  // matters most — a regenerated lockfile, a reformatted tree. The cap applies
  // per list, so a file appearing in both is double-counted here; the number is
  // an "at least", which is the honest direction for it to be wrong in.
  const total =
    truncated === undefined
      ? unique.length
      : truncated.staged + truncated.unstaged;
  if (total <= limit) return unique.slice(0, limit);
  return [...unique.slice(0, limit), `…and ${total - limit} more`];
}

export type SwitchOutcome =
  | { kind: "switched"; carried: boolean }
  | { kind: "cancelled" }
  /** The refs snapshot was stale and another worktree holds the branch. Not an
   *  error: the caller re-lists and reveals that worktree, which is what the
   *  user asked for. Which worktree is deliberately not carried here — git's
   *  refusal names a path, not an id, so the caller resolves it. */
  | { kind: "held" }
  | { kind: "failed"; code: string; message: string };

/**
 * Move `worktreeId` onto `branch`, confirming first when the destination is (or
 * might be) dirty.
 *
 * `checked_out_elsewhere` comes back as `held` rather than a failure. Occupancy
 * is decided upstream from a `repo:refs` snapshot held in component state, and
 * a second window or a terminal can check a branch out after that read — so a
 * row believed free can still collide. That is the same situation as a row
 * known to be occupied, and it resolves the same way.
 */
export async function guardedSwitchBranch({
  worktreeId,
  worktreeLabel,
  fromBranch,
  branch,
  skipDirtyConfirm = false
}: {
  worktreeId: WorktreeId;
  /** How the prompt names the checkout being moved — its folder, not its
   *  branch, which the destination already names. */
  worktreeLabel: string;
  /** The branch being left, for "Commit on <x> first". */
  fromBranch: string;
  branch: string;
  /** Set when the caller has already asked the user. */
  skipDirtyConfirm?: boolean;
}): Promise<SwitchOutcome> {
  let carryChanges = false;
  if (!skipDirtyConfirm) {
    const dirty = await readDirtyState(worktreeId);
    if (dirty.kind === "missing") {
      return { kind: "failed", code: "worktree_missing", message: dirty.message };
    }
    if (dirty.kind !== "clean") {
      const facts = await dirtyFacts(worktreeId);
      const intent = await askDirtyIntent(
        dirty,
        worktreeLabel,
        fromBranch,
        branch,
        facts
      );
      if (intent === "cancel") return { kind: "cancelled" };
      if (intent === "commit_first") {
        nudgeToCommit();
        return { kind: "cancelled" };
      }
      carryChanges = true;
    }
  }

  const result = await dispatch("branch:switch", {
    worktreeId,
    branch,
    ...(carryChanges ? { carryChanges: true } : {})
  });
  if (result.ok) return { kind: "switched", carried: result.value.carried };

  if (result.error.code === "checked_out_elsewhere") return { kind: "held" };
  return {
    kind: "failed",
    code: result.error.code,
    message: result.error.message
  };
}

/**
 * The whole "make this branch the one I am working on" gesture, including the
 * two recoveries that are not failures — shared by every branch list so they
 * cannot drift into behaving differently for the same verb.
 *
 * `held` is resolved here rather than reported: occupancy is decided from a
 * `repo:refs` snapshot the caller is holding in state, and a second window or a
 * terminal can check the branch out after that read. Going to whoever holds it
 * now is what the user asked for either way, so the fresh snapshot is used to
 * find them — and handed back through `onRefs`, since the caller that owns a
 * snapshot should not then have to re-read it.
 *
 * Remote-only branches pass their SHORT name: `git switch foo` DWIMs a bare
 * remote name into a new local tracking branch, which is exactly what "switch
 * me to origin/foo" should mean.
 */
export async function switchWorktreeToBranch({
  repoId,
  worktreeId,
  worktreeLabel,
  fromBranch,
  branch,
  onRevealWorktree,
  onRefs
}: {
  repoId: string;
  worktreeId: WorktreeId;
  /** How the dirty prompt names the checkout being moved — its folder. */
  worktreeLabel: string;
  /** The branch being left, for "Commit on <x> first". */
  fromBranch: string;
  branch: string;
  onRevealWorktree: (worktreeId: WorktreeId) => void;
  /** Receives a snapshot read during `held` recovery, when one was read. */
  onRefs?: ((refs: RepoRefs) => void) | undefined;
}): Promise<"switched" | "revealed" | "cancelled" | "failed"> {
  const outcome = await guardedSwitchBranch({
    worktreeId,
    worktreeLabel,
    fromBranch,
    branch
  });
  if (outcome.kind === "switched") return "switched";
  if (outcome.kind === "cancelled") return "cancelled";

  if (outcome.kind === "held") {
    const fresh = await dispatch("repo:refs", { repoId });
    if (fresh.ok) {
      onRefs?.(fresh.value);
      const held = fresh.value.branches.find((b) => b.name === branch);
      const holder =
        held === undefined ? null : holderWorktreeId(held, worktreeId);
      if (holder !== null) {
        onRevealWorktree(holder);
        return "revealed";
      }
    }
    showErrorToast({
      title: "Switch failed",
      message: `${branch} is checked out in another worktree.`,
      subject: { repoId }
    });
    return "failed";
  }

  showErrorToast({
    title:
      outcome.code === "carry_conflicts"
        ? "Your changes stayed put"
        : "Switch failed",
    message:
      outcome.code === "dirty"
        ? `${branch} could not be checked out without overwriting local changes. Commit or stash them first.`
        : outcome.message.split("\n")[0],
    detail: outcome.message,
    subject: { repoId }
  });
  return "failed";
}
