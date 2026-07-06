import { join, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

export type WatcherCallbacks = {
  onRepoRefsChanged: (repoId: string) => void;
  onWorktreeTreeChanged: (worktreeId: string) => void;
};

// Never descend into these — watching node_modules etc. is what pegged
// fseventd and hung the app. Segment-matched against every path component.
const IGNORE_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode"
]);

function isIgnoredPath(p: string): boolean {
  return p.split(sep).some((seg) => IGNORE_SEGMENTS.has(seg));
}

const DEBOUNCE_MS = 300;

/**
 * Watches ONLY what the user is currently looking at — the active repo's ref
 * store (commits, fetches, branch moves) and the active worktree's working
 * tree (dirty edits) — never every repo/worktree. Both are single-slot
 * (activating a new one closes the old), so at most two watchers exist at
 * once, and events are debounced so a burst collapses into one recompute.
 * This keeps FSEvents cost flat regardless of repo/worktree count.
 */
export class WorktreeWatchers {
  private repoWatcher: { repoId: string; watcher: FSWatcher } | null = null;
  private worktreeWatcher: { worktreeId: string; watcher: FSWatcher } | null =
    null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly cb: WatcherCallbacks) {}

  private debounce(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, DEBOUNCE_MS)
    );
  }

  /** Watch the active repo's refs (cheap — refs are small). Replaces any prior. */
  watchActiveRepo(repoId: string, repoPath: string): void {
    if (this.repoWatcher?.repoId === repoId) return;
    void this.repoWatcher?.watcher.close();
    const gitDir = join(repoPath, ".git");
    const watcher = chokidar.watch(
      [
        join(gitDir, "HEAD"),
        join(gitDir, "refs"),
        join(gitDir, "packed-refs")
      ],
      {
        ignoreInitial: true,
        depth: 5,
        ignorePermissionErrors: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 80 }
      }
    );
    watcher.on("all", () =>
      this.debounce(`repo:${repoId}`, () => this.cb.onRepoRefsChanged(repoId))
    );
    watcher.on("error", () => undefined);
    this.repoWatcher = { repoId, watcher };
  }

  /** Deep-watch one worktree's working tree, heavy dirs excluded. Replaces any prior. */
  watchActiveWorktree(worktreeId: string, worktreePath: string): void {
    if (this.worktreeWatcher?.worktreeId === worktreeId) return;
    void this.worktreeWatcher?.watcher.close();
    const watcher = chokidar.watch(worktreePath, {
      ignoreInitial: true,
      depth: 12,
      followSymlinks: false,
      ignorePermissionErrors: true,
      ignored: (p: string) => isIgnoredPath(p),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    });
    watcher.on("all", () =>
      this.debounce(`wt:${worktreeId}`, () =>
        this.cb.onWorktreeTreeChanged(worktreeId)
      )
    );
    watcher.on("error", () => undefined);
    this.worktreeWatcher = { worktreeId, watcher };
  }

  async closeAll(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.repoWatcher !== null) {
      await this.repoWatcher.watcher.close();
      this.repoWatcher = null;
    }
    if (this.worktreeWatcher !== null) {
      await this.worktreeWatcher.watcher.close();
      this.worktreeWatcher = null;
    }
  }
}
