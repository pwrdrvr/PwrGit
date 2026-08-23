import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { registerSubmoduleHandlers } from "./submodule-handlers";
import type { GitExec, GitRecordExec } from "./dugite";

const git: GitExec = vi.fn(async () =>
  ok({ stdout: "", stderr: "", exitCode: 0 })
);
const recordGit: GitRecordExec = vi.fn(async () =>
  ok({ records: [], stderr: "", exitCode: 0, truncated: false })
);

function setup(path: string | null) {
  const db = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => (path === null ? undefined : { path }))
    }))
  } as unknown as DB;
  const bus = new CommandBus();
  registerSubmoduleHandlers(bus, db, git, recordGit);
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

  it("runs as a read-only audit without claiming the mutation queue", async () => {
    const bus = setup("/repos/project");

    await expect(
      bus.dispatch("submodules:list", {
        worktreeId: "worktree-1"
      })
    ).resolves.toEqual(
      ok({ submodules: [], truncated: false, issues: [] })
    );
    expect(recordGit).toHaveBeenCalled();
    expect(git).toHaveBeenCalled();
  });
});
