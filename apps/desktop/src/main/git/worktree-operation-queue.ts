/**
 * Serializes Git operations within a worktree or repository without blocking
 * unrelated scopes. Worktree locking keeps status reads behind checkout
 * mutations; repository locking keeps concurrent fetches from racing while
 * updating their shared remote-tracking refs.
 */
export class WorktreeOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(worktreeId: string, operation: () => Promise<T>): Promise<T> {
    return this.runScoped(`worktree:${worktreeId}`, operation);
  }

  async runRepository<T>(
    repoId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runScoped(`repository:${repoId}`, operation);
  }

  private async runScoped<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
