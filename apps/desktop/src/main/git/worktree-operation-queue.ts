/**
 * Serializes worktree-sensitive Git operations without blocking unrelated
 * worktrees. A status read that overlaps checkout can otherwise observe the
 * files after they move but before Git commits the new index, publishing a
 * large, transient dirty state to the UI.
 */
export class WorktreeOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(worktreeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(worktreeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(worktreeId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(worktreeId) === tail) {
        this.tails.delete(worktreeId);
      }
    }
  }
}
