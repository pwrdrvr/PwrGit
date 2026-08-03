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
    ): Promise<Result<{ sourceHead: string }>> =>
      ok({ sourceHead: "head-at-check" })
  );
  const refresher = {
    refreshWorktree: vi.fn()
  } as unknown as WorktreeRefresher;
  registerRebaseHandlers(bus, fakeDb(), refresher, {
    apply,
    dryRun,
    createToken: () => "approval-1"
  });
  return { bus, apply, dryRun, refresher };
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
    expect(apply.mock.calls[0]?.[5]).toBe("head-at-check");
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
});
