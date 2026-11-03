import { describe, expect, it } from "vitest";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WorktreeOperationQueue", () => {
  it("breaks an inverted repository/worktree cycle before enqueueing it", async () => {
    const queue = new WorktreeOperationQueue();
    const repositoryHeld = deferred();
    const worktreeHeld = deferred();
    const acquireOther = deferred();
    const settled: string[] = [];
    const repository = queue.runRepository("repo", async () => {
      repositoryHeld.resolve();
      await acquireOther.promise;
      return queue.run("worktree", async () => "pulled");
    });
    const worktree = queue.run("worktree", async () => {
      worktreeHeld.resolve();
      await acquireOther.promise;
      return queue.runRepository("repo", async () => "retracked");
    });
    void repository.then(() => settled.push("pulled"));
    void worktree.then(
      () => settled.push("retracked"),
      () => settled.push("inversion rejected")
    );
    await Promise.all([repositoryHeld.promise, worktreeHeld.promise]);
    acquireOther.resolve();
    await expect(queue.runRepository("unrelated", async () => "free")).resolves.toBe("free");
    // A macrotask boundary drains ready promise continuations; no elapsed-time
    // guess or test timeout is needed to distinguish a cycle from completion.
    await nextTurn();
    expect(settled).toEqual(["inversion rejected", "pulled"]);
    await expect(worktree).rejects.toThrow("repository scope before worktree scope");
    await expect(repository).resolves.toBe("pulled");
    await expect(queue.runRepository("repo", () => queue.run("worktree", async () => "recovered")))
      .resolves.toBe("recovered");
  });

  it.each(["worktree", "repository"] as const)("rejects same-key %s reentry without poisoning its queue", async (scope) => {
    const queue = new WorktreeOperationQueue();
    const run = scope === "worktree" ? queue.run.bind(queue) : queue.runRepository.bind(queue);
    let outcome: unknown;
    const operation = run("same", () => run("same", async () => "nested"));
    void operation.then((value) => { outcome = value; }, (cause: unknown) => { outcome = cause; });
    await nextTurn();
    expect(outcome).toBeInstanceOf(Error);
    await expect(operation).rejects.toThrow(`already holds ${scope}:same`);
    await expect(run("same", async () => "next")).resolves.toBe("next");
  });

  it("keeps a status probe behind an active checkout mutation", async () => {
    const queue = new WorktreeOperationQueue();
    const mutation = deferred();
    const started: string[] = [];

    const pull = queue.run("worktree-1", async () => {
      started.push("pull");
      await mutation.promise;
    });
    const status = queue.run("worktree-1", async () => {
      started.push("status");
      return "clean";
    });

    await Promise.resolve();
    expect(started).toEqual(["pull"]);
    mutation.resolve();
    await expect(status).resolves.toBe("clean");
    await pull;
    expect(started).toEqual(["pull", "status"]);
  });

  it("does not serialize operations from different worktrees", async () => {
    const queue = new WorktreeOperationQueue();
    const mutation = deferred();
    const pull = queue.run("worktree-1", () => mutation.promise);

    await expect(
      queue.run("worktree-2", async () => "clean")
    ).resolves.toBe("clean");

    mutation.resolve();
    await pull;
  });

  it("continues the queue after a failed operation", async () => {
    const queue = new WorktreeOperationQueue();
    const failed = queue.run("worktree-1", async () => {
      throw new Error("checkout failed");
    });
    const next = queue.run("worktree-1", async () => "clean");

    await expect(failed).rejects.toThrow("checkout failed");
    await expect(next).resolves.toBe("clean");
  });
});
