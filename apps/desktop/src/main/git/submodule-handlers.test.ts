import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { registerSubmoduleHandlers } from "./submodule-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import type { GitExec } from "./dugite";

const git: GitExec = vi.fn(async () =>
  ok({ stdout: "", stderr: "", exitCode: 0 })
);

function setup(path: string | null, operations = new WorktreeOperationQueue()) {
  const db = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => (path === null ? undefined : { path }))
    }))
  } as unknown as DB;
  const bus = new CommandBus();
  registerSubmoduleHandlers(bus, db, operations, git);
  return bus;
}

describe("submodules:list handler", () => {
  it("returns a typed not-found error for a removed worktree", async () => {
    await expect(
      setup(null).dispatch("submodules:list", { worktreeId: "gone" })
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      }
    });
  });

  it("waits behind a mutation so it never reads a half-written index", async () => {
    const operations = new WorktreeOperationQueue();
    let release!: () => void;
    const mutation = operations.run(
      "worktree-1",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const bus = setup("/repos/project", operations);

    const pending = bus.dispatch("submodules:list", {
      worktreeId: "worktree-1"
    });
    await Promise.resolve();
    expect(git).not.toHaveBeenCalled();

    release();
    await mutation;
    await expect(pending).resolves.toEqual(
      ok({ submodules: [], truncated: false, issues: [] })
    );
    expect(git).toHaveBeenCalled();
  });
});
