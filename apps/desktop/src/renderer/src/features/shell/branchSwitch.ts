import type { RepoRefs, WorktreeId } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import { holderWorktreeId } from "../sidebar/branch-focus";
import { confirmDialog } from "./dialogs";

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

/** The confirm's body. Named separately so the wording is testable without a
 *  dialog host, and so both entry points say the same thing. */
export function dirtySwitchMessage(
  dirty: DirtyState,
  worktreeLabel: string,
  branch: string
): string {
  const changes =
    dirty.kind === "dirty"
      ? `${dirty.files} uncommitted ${dirty.files === 1 ? "change" : "changes"}`
      : "uncommitted changes PwrGit could not count";
  return (
    `${worktreeLabel} has ${changes}. Switching to ${branch} carries them over `
    + `to that branch instead of leaving them here.`
  );
}

export type SwitchOutcome =
  | { kind: "switched" }
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
  branch,
  skipDirtyConfirm = false
}: {
  worktreeId: WorktreeId;
  /** How the confirm names the checkout being moved — its folder, not its
   *  branch, which the destination already names. */
  worktreeLabel: string;
  branch: string;
  /** Set when the caller has already confirmed with the user. */
  skipDirtyConfirm?: boolean;
}): Promise<SwitchOutcome> {
  if (!skipDirtyConfirm) {
    const dirty = await readDirtyState(worktreeId);
    if (dirty.kind === "missing") {
      return { kind: "failed", code: "worktree_missing", message: dirty.message };
    }
    if (dirty.kind !== "clean") {
      const proceed = await confirmDialog({
        title: `Switch ${worktreeLabel} to ${branch}?`,
        message: dirtySwitchMessage(dirty, worktreeLabel, branch),
        confirmLabel: "Carry changes over",
        cancelLabel: "Cancel"
      });
      if (!proceed) return { kind: "cancelled" };
    }
  }

  const result = await dispatch("branch:switch", { worktreeId, branch });
  if (result.ok) return { kind: "switched" };

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
  branch,
  onRevealWorktree,
  onRefs
}: {
  repoId: string;
  worktreeId: WorktreeId;
  /** How the dirty confirm names the checkout being moved — its folder. */
  worktreeLabel: string;
  branch: string;
  onRevealWorktree: (worktreeId: WorktreeId) => void;
  /** Receives a snapshot read during `held` recovery, when one was read. */
  onRefs?: ((refs: RepoRefs) => void) | undefined;
}): Promise<"switched" | "revealed" | "cancelled" | "failed"> {
  const outcome = await guardedSwitchBranch({
    worktreeId,
    worktreeLabel,
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
      message: `${branch} is checked out in another worktree.`
    });
    return "failed";
  }

  showErrorToast({
    title: "Switch failed",
    message:
      outcome.code === "dirty"
        ? `${branch} could not be checked out without overwriting local changes. Commit or stash them first.`
        : outcome.message.split("\n")[0],
    detail: outcome.message
  });
  return "failed";
}
