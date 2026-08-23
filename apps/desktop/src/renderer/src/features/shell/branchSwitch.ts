import type { WorktreeId } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
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
  | { kind: "unknown" };

/**
 * Read checkout safety directly from Git rather than trusting a cached coarse
 * snapshot. The main-process probe includes dirty initialized submodules and
 * shares the worktree operation queue with mutations.
 */
export async function readDirtyState(
  worktreeId: WorktreeId
): Promise<DirtyState> {
  const result = await dispatch("worktree:readDirty", { worktreeId });
  if (!result.ok) return { kind: "unknown" };
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
