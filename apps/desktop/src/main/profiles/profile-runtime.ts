import type { DB } from "../persistence/db";

/**
 * Owns the lifetime of background profile scans. An AbortSignal is tied to one
 * particular scan, rather than only to a profile id, so deleting and quickly
 * recreating the same profile id cannot make the old scan current again.
 */
export class ProfileScanCoordinator {
  private readonly active = new Map<string, AbortController>();

  begin(profileId: string): AbortSignal | null {
    if (this.active.has(profileId)) return null;
    const controller = new AbortController();
    this.active.set(profileId, controller);
    return controller.signal;
  }

  abort(profileId: string): void {
    this.active.get(profileId)?.abort();
    this.active.delete(profileId);
  }

  finish(profileId: string, signal: AbortSignal): void {
    if (this.active.get(profileId)?.signal === signal) {
      this.active.delete(profileId);
    }
  }
}

/** Keep polling a selected worktree when it survived another profile's delete. */
export function survivingActiveWorktreeId(
  db: DB,
  activeWorktreeId: string | null
): string | null {
  if (activeWorktreeId === null) return null;
  const exists = db
    .prepare("SELECT 1 FROM worktrees WHERE id = ?")
    .get(activeWorktreeId);
  return exists === undefined ? null : activeWorktreeId;
}
