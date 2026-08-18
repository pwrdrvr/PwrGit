import type { WorktreeId } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
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

/** How long to wait for a first snapshot to be computed before giving up and
 *  calling the tree's dirtiness unknown. Generous: the alternative to waiting
 *  is a confirm the user did not need. */
const FIRST_SNAPSHOT_WAIT_MS = 5_000;

/**
 * Read the destination's dirtiness from a live snapshot.
 *
 * It deliberately does not use the `dirty` count already on the `Worktree` in
 * the repo tree: `repoFromRow` maps `dirty: w.dirty ?? 0` over a LEFT JOIN
 * against `worktree_state`, and that row is written lazily. A worktree whose
 * state has never been computed reports 0 while holding a dozen modified
 * files, so trusting it would skip the confirm in exactly the case the confirm
 * exists to catch.
 *
 * `worktree:getState` returns the CACHED snapshot and only kicks off a refresh
 * — it does not wait for one. So on a repo the user just added, the first read
 * is a miss, and treating that as unknown would prompt about "changes PwrGit
 * could not count" on a perfectly clean tree. A miss is therefore not the
 * answer, it is the question: the refresh the read just started emits
 * `worktree:changed` when the snapshot lands, so wait for that and read again.
 *
 * Only a read that fails, or a snapshot that never arrives, is `unknown` — and
 * unknown still takes the confirm branch. A needless prompt costs one
 * keystroke; a needless carry-over costs the user their working state.
 */
export async function readDirtyState(
  worktreeId: WorktreeId,
  waitMs: number = FIRST_SNAPSHOT_WAIT_MS
): Promise<DirtyState> {
  const snapshot = (state: { dirty: number }): DirtyState =>
    state.dirty > 0 ? { kind: "dirty", files: state.dirty } : { kind: "clean" };

  // Subscribe BEFORE asking. The refresh the read kicks off can finish before
  // a listener attached afterwards would exist, and its event does not repeat.
  let landed: (() => void) | undefined;
  const arrival = new Promise<boolean>((resolve) => {
    landed = () => resolve(true);
  });
  const unsubscribe = subscribe("worktree:changed", (event) => {
    if (event.worktreeId === worktreeId) landed?.();
  });

  try {
    const first = await dispatch("worktree:getState", { worktreeId });
    if (!first.ok) return { kind: "unknown" };
    if (first.value !== null) return snapshot(first.value);

    // Bare setTimeout, not window.setTimeout: this module is exercised by unit
    // tests running under Node, where there is no `window`.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    });
    const arrived = await Promise.race([arrival, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (!arrived) return { kind: "unknown" };

    const second = await dispatch("worktree:getState", { worktreeId });
    if (!second.ok || second.value === null) return { kind: "unknown" };
    return snapshot(second.value);
  } finally {
    unsubscribe();
  }
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
   *  error: the caller reveals that worktree, which is what the user asked for.
   */
  | { kind: "held"; worktreeId: WorktreeId | null }
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
  skipDirtyConfirm = false,
  snapshotWaitMs
}: {
  worktreeId: WorktreeId;
  /** How the confirm names the checkout being moved — its folder, not its
   *  branch, which the destination already names. */
  worktreeLabel: string;
  branch: string;
  /** Set when the caller has already confirmed with the user. */
  skipDirtyConfirm?: boolean;
  /** Test seam: how long to wait for a first snapshot. */
  snapshotWaitMs?: number;
}): Promise<SwitchOutcome> {
  if (!skipDirtyConfirm) {
    const dirty = await readDirtyState(worktreeId, snapshotWaitMs);
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

  if (result.error.code === "checked_out_elsewhere") {
    // The main process knows which worktree, but does not report it on this
    // path; the caller re-lists and finds it. Null means "look it up".
    return { kind: "held", worktreeId: null };
  }
  return {
    kind: "failed",
    code: result.error.code,
    message: result.error.message
  };
}
