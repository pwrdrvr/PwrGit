import { AsyncLocalStorage } from "node:async_hooks";

type HeldScope = { key: string; released: boolean };

/**
 * Serializes Git operations within a worktree or repository without blocking
 * unrelated scopes. Worktree locking keeps status reads behind checkout
 * mutations; repository locking keeps concurrent fetches from racing while
 * updating their shared remote-tracking refs.
 * When both are needed, acquire repository -> worktree. Reversed acquisition
 * and same-scope reentry are rejected before enqueueing, rather than waiting
 * on a cycle that cancellation cannot unwind.
 */
export class WorktreeOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly heldScopes = new AsyncLocalStorage<readonly HeldScope[]>();

  async run<T>(worktreeId: string, operation: () => Promise<T>): Promise<T> {
    return this.runScoped(`worktree:${worktreeId}`, operation);
  }

  async runRepository<T>(
    repoId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runScoped(`repository:${repoId}`, operation);
  }

  async runRepositoryWorktree<T>(
    repoId: string,
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runRepository(repoId, () => this.run(worktreeId, operation));
  }

  private async runScoped<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    // Async descendants inherit the context even after an operation finishes.
    // Only live tokens represent locks; stale context must not refuse a later
    // timer/continuation's otherwise valid acquisition.
    const held = (this.heldScopes.getStore() ?? []).filter((scope) => !scope.released);
    if (held.some((scope) => scope.key === key)) {
      throw new Error(`Git operation already holds ${key}; queue scopes are not reentrant.`);
    }
    if (key.startsWith("repository:") && held.some((scope) => scope.key.startsWith("worktree:"))) {
      throw new Error("Acquire repository scope before worktree scope for Git operations.");
    }
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    await previous;
    const scope: HeldScope = { key, released: false };
    try {
      return await this.heldScopes.run([...held, scope], operation);
    } finally {
      scope.released = true;
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
