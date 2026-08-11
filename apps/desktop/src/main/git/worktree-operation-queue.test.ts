import { describe, expect, it } from "vitest";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WorktreeOperationQueue", () => {
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
