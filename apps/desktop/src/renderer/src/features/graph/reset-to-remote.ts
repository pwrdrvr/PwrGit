import type { RemoteResetMode } from "@pwrgit/shared";
import type { ResetWorktree } from "./ResetToRemoteDialog";

/**
 * An app-wide opener for the reset-to-remote dialog.
 *
 * The dialog used to be local state inside the graph header, which is why the
 * kebab there was the only way to reach it — every other surface that names a
 * branch (the sidebar row, a branch-tip chip, the diverged-pull recovery
 * dialog) would have had to mount its own copy. A one-entry queue, mirrored on
 * `dialogs.ts`, lets any of them ask for it while <ResetToRemoteHost/> renders
 * the single instance.
 */
export type ResetToRemoteRequest = {
  worktree: ResetWorktree;
  /**
   * A fully qualified ref to open on, e.g. `refs/remotes/origin/main`. Callers
   * that already know the target — a right-click on a branch chip — pass it so
   * the picker is never touched.
   */
  preselectRef?: string;
  /** Extra confirmation the opening surface wants to show on success. */
  onComplete?: (mode: RemoteResetMode, branch: string) => void;
};

let pending: ResetToRemoteRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeResetToRemote(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The open request, or null. Stable reference while idle. */
export function currentResetToRemote(): ResetToRemoteRequest | null {
  return pending;
}

export function openResetToRemote(request: ResetToRemoteRequest): void {
  pending = request;
  emit();
}

export function closeResetToRemote(): void {
  if (pending === null) return;
  pending = null;
  emit();
}
