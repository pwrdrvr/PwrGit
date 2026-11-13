import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import { registerBulkSyncHandlers } from "./bulk-sync-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./dugite", async (importOriginal) => ({
  ...await importOriginal<typeof import("./dugite")>(),
  execGit: vi.fn()
}));

describe("bulk sync identity refresh", () => {
  it.each(["fetch", "soft-pull"] as const)(
    "refreshes only repositories with a successful fetch during %s",
    async (mode) => {
      const db = {
        prepare: (sql: string) => ({
          get: () => ({ id: "profile-1" }),
          all: () => sql.includes("FROM repos")
            ? ["success", "failed", "skipped"].map((id) => ({ id, name: id, path: `/repos/${id}` }))
            : []
        })
      } as unknown as DB;
      vi.mocked(execGit).mockImplementation(async (args, cwd) => {
        if (args[0] === "remote") return ok({ exitCode: 0, stdout: "origin\n", stderr: "" });
        if (args[0] === "config") return ok({ exitCode: 0, stdout: cwd.endsWith("skipped") ? "true" : "false", stderr: "" });
        if (args[0] === "fetch") return ok({ exitCode: cwd.endsWith("failed") ? 1 : 0, stdout: "", stderr: "" });
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      });
      const refreshIdentity = vi.fn();
      const bus = new CommandBus();
      registerBulkSyncHandlers(bus, db, {
        refreshWorktree: vi.fn(),
        refreshRepoWorktrees: vi.fn()
      }, new WorktreeOperationQueue(), undefined, refreshIdentity);

      const result = await bus.dispatch("remote:bulkSync", {
        profileId: "profile-1", operationId: "bulk-1", mode
      });
      expect(result.ok).toBe(true);
      expect(refreshIdentity).toHaveBeenCalledExactlyOnceWith("success");
    }
  );
});

describe("bulk sync and the profile's folders", () => {
  it("looks for new repositories at the start of every run", async () => {
    // A Fetch/Pull run, yours or the timer's, is when new clones get looked
    // for (root-discovery.ts); an unknown profile starts nothing.
    const db = {
      prepare: (sql: string) => ({
        get: (id: string) => (id === "profile-1" ? { id } : undefined),
        all: () => (sql.includes("FROM repos") ? [] : [])
      })
    } as unknown as DB;
    const onRunStart = vi.fn();
    const bus = new CommandBus();
    registerBulkSyncHandlers(bus, db, {
      refreshWorktree: vi.fn(),
      refreshRepoWorktrees: vi.fn()
    }, new WorktreeOperationQueue(), undefined, undefined, onRunStart);

    await bus.dispatch("remote:bulkSync", {
      profileId: "profile-1", operationId: "bulk-1", mode: "fetch"
    });
    await bus.dispatch("remote:bulkSync", {
      profileId: "nobody", operationId: "bulk-2", mode: "fetch"
    });
    expect(onRunStart).toHaveBeenCalledExactlyOnceWith("profile-1");
  });
});
