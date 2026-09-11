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
