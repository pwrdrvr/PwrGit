import { describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type RebaseCommitRef,
  type Result
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import type { WorktreeRefresher } from "./worktree-handlers";
import {
  registerRebaseHandlers,
  type RebaseHandlerDependencies
} from "./rebase-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const commits: RebaseCommitRef[] = [
  { hash: "bbbbbbbb", subject: "top" },
  { hash: "aaaaaaaa", subject: "older" }
];

function fakeDb(): DB {
  return {
    prepare: (sql: string) => ({
      get: () =>
        sql.includes("JOIN profiles")
          ? { path: "/repo", email: "me@example.com", author_name: "Me" }
          : { path: "/repo" }
    })
  } as unknown as DB;
}

function setup() {
  const bus = new CommandBus();
  const apply = vi.fn(
    async (
      ..._args: Parameters<RebaseHandlerDependencies["apply"]>
    ): Promise<Result<void>> => ok(undefined)
  );
  const dryRun = vi.fn(
    async (
      ..._args: Parameters<RebaseHandlerDependencies["dryRun"]>
    ): ReturnType<RebaseHandlerDependencies["dryRun"]> =>
      ok({
        sourceHead: "head-at-check",
        sourceRef: "refs/heads/feature",
        proof: {
          commitCount: 2,
          resultCount: 1,
          steps: 2,
          tree: "4c1f9e0".padEnd(40, "0"),
          durationMs: 12
        }
      })
  );
  const refresher = {
    refreshWorktree: vi.fn()
  } as unknown as WorktreeRefresher;
  const operations = new WorktreeOperationQueue();
  registerRebaseHandlers(bus, fakeDb(), refresher, operations, {
    apply,
    dryRun,
    createToken: () => "approval-1"
  });
  return { bus, apply, dryRun, refresher, operations };
}

describe("rebase handler approval gate", () => {
  it("does not apply without a successful check", async () => {
    const { bus, apply } = setup();
    const result = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "squash",
      approvalToken: "missing"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("dry_run_required");
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not apply when the operation or selection differs from the check", async () => {
    const { bus, apply } = setup();
    const checked = await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "squash"
    });
    expect(checked.ok && checked.value.status).toBe("clean");
    if (checked.ok && checked.value.status === "clean") {
      expect(checked.value.message).toContain(
        "Other repo-local Git settings can still affect Apply"
      );
    }

    const result = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "reorder",
      approvalToken: "approval-1"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("dry_run_mismatch");
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not apply when the ordered commit selection differs from the check", async () => {
    const { bus, apply } = setup();
    await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "squash"
    });

    const result = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits: [commits[1] as RebaseCommitRef, commits[0] as RebaseCommitRef],
      op: "squash",
      approvalToken: "approval-1"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("dry_run_mismatch");
    expect(apply).not.toHaveBeenCalled();
  });

  it("passes the checked source HEAD into the immediate apply revalidation", async () => {
    const { bus, apply } = setup();
    apply.mockResolvedValueOnce(
      err({
        kind: "rebase",
        code: "dry_run_stale",
        message: "Run the check again."
      })
    );
    await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "squash"
    });

    const result = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "squash",
      approvalToken: "approval-1"
    });
    expect(result.ok).toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[5]).toEqual({
      head: "head-at-check",
      headRef: "refs/heads/feature"
    });
  });

  it("returns a typed snag and issues no approval when the check fails", async () => {
    const { bus, dryRun, apply } = setup();
    dryRun.mockResolvedValueOnce(
      err({ kind: "rebase", code: "conflict", message: "Would conflict." })
    );
    const checked = await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "reorder"
    });
    expect(checked).toEqual(
      ok({ status: "snag", code: "conflict", message: "Would conflict." })
    );

    const applied = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "reorder",
      approvalToken: "approval-1"
    });
    expect(applied.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("carries a conflict's structured detail into the snag", async () => {
    const { bus, dryRun } = setup();
    const detail = {
      kind: "conflict" as const,
      step: 2,
      total: 2,
      hash: "bbbbbbbb",
      subject: "top",
      files: ["a.ts"]
    };
    dryRun.mockResolvedValueOnce(
      err({ kind: "rebase", code: "conflict", message: "Would conflict.", snag: detail })
    );
    const checked = await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "reorder"
    });
    expect(checked).toEqual(
      ok({ status: "snag", code: "conflict", message: "Would conflict.", detail })
    );
  });

  it("binds the approval to the program's shape, not its message", async () => {
    const { bus, apply, dryRun } = setup();
    const program = (message: string) => ({
      commits: [{ members: ["aaaaaaaa", "bbbbbbbb"], message }]
    });
    const checked = await bus.dispatch("rebase:check", {
      worktreeId: "wt-1",
      commits,
      op: "squash",
      program: program("first draft")
    });
    expect(checked.ok && checked.value.status === "clean" && checked.value.proof.steps).toBe(2);
    expect(dryRun.mock.calls[0]?.[5]).toEqual({ program: program("first draft") });

    const applied = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "squash",
      approvalToken: "approval-1",
      program: program("edited after the check")
    });
    expect(applied.ok).toBe(true);
    expect(apply.mock.calls[0]?.[6]).toEqual(program("edited after the check"));
  });

  it("refuses Apply when a Tidy program's shape changed after the check", async () => {
    const { bus, apply } = setup();
    const folded = {
      commits: [{ members: ["aaaaaaaa", "bbbbbbbb"], message: "one" }]
    };
    const split = {
      commits: [
        { members: ["aaaaaaaa"], message: "one" },
        { members: ["bbbbbbbb"], message: null }
      ]
    };
    await bus.dispatch("rebase:check", { worktreeId: "wt-1", commits, op: "tidy", program: folded });
    const applied = await bus.dispatch("rebase:apply", {
      worktreeId: "wt-1",
      commits,
      op: "tidy",
      approvalToken: "approval-1",
      program: split
    });
    expect(!applied.ok && applied.error.code).toBe("dry_run_mismatch");
    expect(apply).not.toHaveBeenCalled();
  });

  it("snags a Tidy check that brings no program, before any Git runs", async () => {
    const { bus, dryRun } = setup();
    const checked = await bus.dispatch("rebase:check", { worktreeId: "wt-1", commits, op: "tidy" });
    expect(checked.ok && checked.value.status).toBe("snag");
    expect(dryRun).not.toHaveBeenCalled();
  });
});
