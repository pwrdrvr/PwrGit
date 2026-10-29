// What "recent" means for a repository: the Focused list and the sync
// button's "recent" scope. Main reads the user's own commits over this window
// (`worktree-state.ts`), and the renderer judges visits and those commits
// against it, so the two must share one number.

/** Days a visit in PwrGit, or a commit you authored, keeps a repo recent. */
export const RECENT_DAYS = 7;

export const RECENT_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;
