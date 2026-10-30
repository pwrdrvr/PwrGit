import {
  pwrgitLeftOnStashMessage,
  type RepoRefs,
  type WorktreeId
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { holderWorktreeId, isBranchSentinel } from "../sidebar/branch-focus";
import { chooseDialog } from "./dialogs";

/**
 * The guarded checkout every branch-switch entry point goes through.
 *
 * Uncommitted work in a checkout is not tied to a branch: it is files in a
 * folder, and a switch changes the folder around them. So the question for a
 * dirty checkout is where that work should end up — brought along to the
 * destination, or left behind on the branch it was made on — and neither
 * answer commits anything (GitHub Desktop's model).
 *
 * "Bring" is a plain `git switch` first. Git carries what the destination does
 * not touch and refuses, touching nothing, when it would overwrite something,
 * so the common case needs no stash at all. Only that refusal asks a second
 * question, about exactly the files Git named.
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
  worktreeLabel: string
): string {
  const changes =
    dirty.kind === "dirty"
      ? `${dirty.files} uncommitted ${dirty.files === 1 ? "change" : "changes"}`
      : "uncommitted changes PwrGit could not count";
  return `${worktreeLabel} has ${changes}. Where should they go?`;
}

/** What the reader wants done with the uncommitted work. */
export type DirtyIntent = "bring" | "leave" | "cancel";

/** What the reader wants done once the destination turned out to have its own
 *  version of some of the files. */
export type OverwriteIntent = "merge" | "leave" | "cancel";

/** `Worktree.branch` is not always a branch name. `branch-focus` owns the rule
 *  for which values are sentinels — a second copy here would drift the first
 *  time one is added, and print it at the reader as though it were a branch. */
function branchBeingLeft(fromBranch: string): string | null {
  return fromBranch !== "" && !isBranchSentinel(fromBranch) ? fromBranch : null;
}

/** "Leave my changes on <branch>". A detached checkout has no branch to come
 *  back to, so its stash is offered from the Stashes tab instead. */
function leaveChoice(fromBranch: string): {
  id: "leave";
  label: string;
  detail: string;
} {
  const here = branchBeingLeft(fromBranch);
  return here === null
    ? {
        id: "leave",
        label: "Leave my changes in the stash",
        detail:
          "PwrGit stashes them. Put them back from the Stashes tab whenever you like."
      }
    : {
        id: "leave",
        label: `Leave my changes on ${here}`,
        detail: `PwrGit stashes them with ${here}. Come back to ${here} and PwrGit offers to put them back.`
      };
}

/**
 * Ask where the uncommitted work should go, rather than assuming.
 *
 * Both answers name a destination for the work, not a git mechanism, and
 * neither commits: committing is a decision with a message attached, and a
 * modal about switching is the wrong place to write one. "Bring" comes first
 * and is the default, because the work is files in this folder and staying
 * put is what files do.
 */
export async function askDirtyIntent(
  dirty: DirtyState,
  worktreeLabel: string,
  fromBranch: string,
  branch: string,
  facts: string[] = []
): Promise<DirtyIntent> {
  const answer = await chooseDialog({
    title: `Switch to ${branch}?`,
    message: dirtySwitchMessage(dirty, worktreeLabel),
    facts,
    choices: [
      {
        id: "bring",
        label: `Bring my changes to ${branch}`,
        detail: `They stay in the folder as they are. If ${branch} has its own version of one of these files, PwrGit tells you before anything moves.`
      },
      leaveChoice(fromBranch)
    ],
    cancelLabel: "Cancel"
  });
  if (answer === "bring") return "bring";
  if (answer === "leave") return "leave";
  return "cancel";
}

/** At most `limit` entries, then "…and N more" — the same shape as
 *  `dirtyFacts`, so both prompts list files alike. */
function capFacts(paths: readonly string[], limit = 5): string[] {
  if (paths.length <= limit) return [...paths];
  return [...paths.slice(0, limit), `…and ${paths.length - limit} more`];
}

/**
 * The second question, asked only when a plain switch refused: `branch`
 * changed some of the files that hold uncommitted work, so bringing them along
 * as they are would overwrite one side. Nothing has moved yet.
 *
 * `paths` are the files Git named in its refusal. When Git's message could
 * not be read for them, the dialog still asks; it just cannot list them.
 */
export async function askOverwriteIntent(
  fromBranch: string,
  branch: string,
  paths: readonly string[]
): Promise<OverwriteIntent> {
  const here = branchBeingLeft(fromBranch) ?? "this checkout";
  const answer = await chooseDialog({
    title:
      paths.length === 1
        ? `${branch} has its own version of this file`
        : `${branch} has its own version of these files`,
    message: `Switching would overwrite your changes to ${
      paths.length === 1 ? "it" : paths.length === 0 ? "some of them" : "them"
    }, so nothing has moved yet.`,
    facts: capFacts(paths),
    choices: [
      {
        id: "merge",
        label: `Merge my changes into ${branch}'s`,
        detail: `PwrGit combines your changes with ${branch}'s versions. If they conflict, nothing moves — you stay on ${here} with them untouched.`
      },
      leaveChoice(fromBranch)
    ],
    cancelLabel: "Cancel"
  });
  if (answer === "merge") return "merge";
  if (answer === "leave") return "leave";
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

/**
 * Put back the changes the reader left on `branch`, from the stash entry the
 * leaving switch made. `stash:pop` applies by commit identity and drops the
 * entry only after a clean apply, so a failed restore keeps it.
 */
export async function restoreLeftChanges(
  worktreeId: WorktreeId,
  branch: string,
  stashHash: string
): Promise<boolean> {
  const popped = await dispatch("stash:pop", { worktreeId, stashHash });
  if (popped.ok) {
    showInfoToast({
      title: "Changes restored",
      message: `Your changes are back on ${branch}.`,
      subject: { worktreeId }
    });
    return true;
  }
  showErrorToast({
    title: "Could not restore your changes",
    message: `${popped.error.message.split("\n")[0]} They are still in the stash as "${pwrgitLeftOnStashMessage(branch)}".`,
    detail: popped.error.message,
    subject: { worktreeId }
  });
  return false;
}

/**
 * After a switch onto `branch`, offer back the changes the reader left there.
 *
 * The leaving switch stashed them as `pwrgitLeftOnStashMessage(branch)`; the
 * newest such entry is the one offered. Best-effort throughout: a failed read
 * costs the toast, never the switch, which has already happened.
 */
export async function offerLeftChanges(
  worktreeId: WorktreeId,
  branch: string
): Promise<void> {
  try {
    const listed = await dispatch("stash:list", { worktreeId });
    if (!listed.ok) return;
    const wanted = pwrgitLeftOnStashMessage(branch);
    // `stash:list` is newest first.
    const entry = listed.value.find((candidate) => candidate.name === wanted);
    if (entry === undefined) return;
    const details = await dispatch("stash:details", {
      worktreeId,
      stashHash: entry.hash
    });
    const count = details.ok ? details.value.files.length : 0;
    showInfoToast({
      key: `left-changes:${worktreeId}`,
      title: "Your changes are waiting",
      message:
        count > 0
          ? `You left ${count} ${count === 1 ? "change" : "changes"} on ${branch}.`
          : `You left changes on ${branch}.`,
      subject: { worktreeId },
      action: {
        label: "Restore",
        run: () => {
          void restoreLeftChanges(worktreeId, branch, entry.hash);
        }
      }
    });
  } catch {
    // The offer is a convenience; the entry stays in the Stashes tab.
  }
}

export type SwitchOutcome =
  | { kind: "switched"; carried: boolean; left: boolean }
  | { kind: "cancelled" }
  /** The refs snapshot was stale and another worktree holds the branch. Not an
   *  error: the caller re-lists and reveals that worktree, which is what the
   *  user asked for. Which worktree is deliberately not carried here — git's
   *  refusal names a path, not an id, so the caller resolves it. */
  | { kind: "held" }
  | { kind: "failed"; code: string; message: string };

/**
 * Move `worktreeId` onto `branch`, asking first when the destination is (or
 * might be) dirty, and again if Git refuses to bring the work along as it is.
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
  /** The branch being left, for "Leave my changes on <x>". */
  fromBranch: string;
  branch: string;
  /** Set when the caller has already asked the user where the work goes. A
   *  refusal to overwrite files is still asked about: that is a question the
   *  caller could not have known to ask. */
  skipDirtyConfirm?: boolean;
}): Promise<SwitchOutcome> {
  let changes: "leave" | undefined;
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
      if (intent === "leave") changes = "leave";
    }
  }

  let result = await dispatch("branch:switch", {
    worktreeId,
    branch,
    ...(changes === undefined ? {} : { changes })
  });
  // A plain switch — "bring my changes" — refused because `branch` has its own
  // version of some of the files. Nothing moved; ask about exactly those.
  if (!result.ok && result.error.code === "switch_would_overwrite") {
    const answer = await askOverwriteIntent(
      fromBranch,
      branch,
      result.error.paths ?? []
    );
    if (answer === "cancel") return { kind: "cancelled" };
    result = await dispatch("branch:switch", {
      worktreeId,
      branch,
      changes: answer
    });
  }
  if (result.ok) {
    // Not awaited: the offer reads the repository's stash stack, which can
    // queue behind a fetch, and the switch has already happened.
    void offerLeftChanges(worktreeId, branch);
    return {
      kind: "switched",
      carried: result.value.carried,
      left: result.value.left
    };
  }

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
  /** The branch being left, for "Leave my changes on <x>". */
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
    // `switch_would_overwrite` never lands here: `guardedSwitchBranch` asks
    // the overwrite question instead of returning it.
    message: outcome.message.split("\n")[0],
    detail: outcome.message,
    subject: { repoId }
  });
  return "failed";
}
