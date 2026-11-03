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
  it("takes the repository first without reserving a worktree while queued", async () => {
    const queue = new WorktreeOperationQueue();
    const repositoryGate = deferred();
    const repository = queue.runRepository("repo", () => repositoryGate.promise);
    const started: string[] = [];
    const combined = queue.runRepositoryWorktree("repo", "worktree", async () => {
      started.push("combined");
      return "done";
    });
    await expect(queue.run("worktree", async () => "probe")).resolves.toBe("probe");
    expect(started).toEqual([]);
    repositoryGate.resolve();
    await repository;
    await expect(combined).resolves.toBe("done");
    expect(started).toEqual(["combined"]);
  });

  it("holds both scopes while allowing other repositories and worktrees to run", async () => {
    const queue = new WorktreeOperationQueue();
    const entered = deferred();
    const finish = deferred();
    const started: string[] = [];
    const combined = queue.runRepositoryWorktree("repo", "worktree", async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    const repository = queue.runRepository("repo", async () => { started.push("repository"); });
    const worktree = queue.run("worktree", async () => { started.push("worktree"); });
    await expect(queue.runRepositoryWorktree("other", "other", async () => "independent"))
      .resolves.toBe("independent");
    expect(started).toEqual([]);
    finish.resolve();
    await Promise.all([combined, repository, worktree]);
    expect(started.sort()).toEqual(["repository", "worktree"]);
  });

  it("releases both scopes after a callback throws", async () => {
    const queue = new WorktreeOperationQueue();
    const failed = queue.runRepositoryWorktree("repo", "worktree", () => {
      throw new Error("checkout failed");
    });
    await expect(failed).rejects.toThrow("checkout failed");
    await expect(queue.runRepositoryWorktree("repo", "worktree", async () => "recovered"))
      .resolves.toBe("recovered");
  });

  it("ignores released locks inherited by a gated async descendant", async () => {
    const queue = new WorktreeOperationQueue();
    const resume = deferred();
    let descendant!: Promise<string>;
    await queue.runRepositoryWorktree("repo", "worktree", async () => {
      descendant = (async () => {
        await resume.promise;
        return queue.runRepositoryWorktree("repo", "worktree", async () => "later");
      })();
    });
    resume.resolve();
    await expect(descendant).resolves.toBe("later");
  });

  it("keeps lock contexts independent between queue instances", async () => {
    const first = new WorktreeOperationQueue();
    const second = new WorktreeOperationQueue();
    await expect(first.run("worktree", () =>
      second.runRepositoryWorktree("repo", "worktree", async () => "independent")
    )).resolves.toBe("independent");
  });

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
    void repository.then(() => settled.push("pulled"), () => settled.push("pull failed"));
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
