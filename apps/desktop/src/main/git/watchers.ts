import { join, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

export type WatcherCallbacks = {
  onRepoRefsChanged: (repoId: string) => void;
  onWorktreeTreeChanged: (worktreeId: string) => void;
};

/**
 * Lazy fs watching (KTD2). Each active-profile repo gets a cheap watch on its
 * ref store (commits, checkouts, branch moves, linked-worktree HEADs); the
 * currently-selected worktree gets a deeper watch on its working tree (dirty
 * edits). Only one working-tree watch is active at a time, bounding handles.
 */
export class WorktreeWatchers {
  private readonly repoWatchers = new Map<string, FSWatcher>();
  private activeWatcher: { worktreeId: string; watcher: FSWatcher } | null =
    null;

  constructor(private readonly cb: WatcherCallbacks) {}

  watchRepoRefs(repoId: string, repoPath: string): void {
    if (this.repoWatchers.has(repoId)) return;
    const gitDir = join(repoPath, ".git");
    const watcher = chokidar.watch(
      [join(gitDir, "HEAD"), join(gitDir, "refs"), join(gitDir, "worktrees")],
      {
        ignoreInitial: true,
        depth: 4,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
      }
    );
    watcher.on("all", () => this.cb.onRepoRefsChanged(repoId));
    watcher.on("error", () => undefined);
    this.repoWatchers.set(repoId, watcher);
  }

  /** Deep-watch one worktree's working tree, replacing the previous one. */
  watchActiveWorktree(worktreeId: string, worktreePath: string): void {
    if (this.activeWatcher?.worktreeId === worktreeId) return;
    void this.activeWatcher?.watcher.close();
    const gitInfix = `${sep}.git${sep}`;
    const gitSuffix = `${sep}.git`;
    const watcher = chokidar.watch(worktreePath, {
      ignoreInitial: true,
      depth: 12,
      ignored: (p: string) => p.includes(gitInfix) || p.endsWith(gitSuffix),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 60 }
    });
    watcher.on("all", () => this.cb.onWorktreeTreeChanged(worktreeId));
    watcher.on("error", () => undefined);
    this.activeWatcher = { worktreeId, watcher };
  }

  async closeAll(): Promise<void> {
    for (const w of this.repoWatchers.values()) await w.close();
    this.repoWatchers.clear();
    if (this.activeWatcher !== null) {
      await this.activeWatcher.watcher.close();
      this.activeWatcher = null;
    }
  }
}
