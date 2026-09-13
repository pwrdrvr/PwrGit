import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PWRGIT_PULL_STASH_MESSAGE,
  err,
  ok,
  type StashEntry
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import {
  registerStashHandlers,
  type StashHandlerDependencies
} from "./stash-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

const entry = (
  selector: string,
  hash: string,
  name: string,
  kind: StashEntry["kind"] = "ordinary"
): StashEntry => ({
  selector,
  hash,
  occurrenceCount: 1,
  shortHash: hash.slice(0, 7),
  baseHash: "b".repeat(40),
  branch: "main",
  subject: "On main: " + name,
  name,
  kind,
  createdAt: "2026-08-23T12:00:00Z"
});

function setup(listed: StashEntry[]) {
  const db = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
    }))
  } as unknown as DB;
  const refresher = {
    refreshWorktree: vi.fn(async () => undefined),
    refreshRepoWorktrees: vi.fn()
  } satisfies WorktreeRefresher;
  const dependencies = {
    git: vi.fn() as unknown as GitExec,
    list: vi.fn(async () => ok(listed)),
    details: vi.fn(async (_git, _path, stash) =>
      ok({ entry: stash, files: [], additions: 0, deletions: 0 })
    ),
    patch: vi.fn(async () => ok("patch")),
    create: vi.fn(async () => ok(true)),
    apply: vi.fn(async () => ok(undefined)),
    pop: vi
      .fn<StashHandlerDependencies["pop"]>()
      .mockResolvedValue(ok(undefined)),
    drop: vi.fn(async () => ok(undefined))
  } satisfies StashHandlerDependencies;
  const bus = new CommandBus();
  registerStashHandlers(
    bus,
    db,
    refresher,
    new WorktreeOperationQueue(),
    dependencies
  );
  return { bus, dependencies, refresher };
}

describe("stash handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-resolves a selected hash to its current non-top selector", async () => {
    const moved = entry("stash@{2}", "2".repeat(40), "selected");
    const { bus, dependencies } = setup([
      entry("stash@{0}", "0".repeat(40), "new top"),
      entry("stash@{1}", "1".repeat(40), "middle"),
      moved
    ]);

    await expect(
      bus.dispatch("stash:pop", {
        worktreeId: "worktree-1",
        stashHash: moved.hash
      })
    ).resolves.toEqual(ok(null));

    expect(dependencies.pop).toHaveBeenCalledWith(
      dependencies.git,
      "/repos/project",
      "stash@{2}"
    );
  });

  it("refuses a hash that has left the stack instead of using a stale selector", async () => {
    const { bus, dependencies } = setup([
      entry("stash@{0}", "0".repeat(40), "other")
    ]);

    await expect(
      bus.dispatch("stash:drop", {
        worktreeId: "worktree-1",
        stashHash: "9".repeat(40)
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" }
    });
    expect(dependencies.drop).not.toHaveBeenCalled();
  });

  it("rejects pop and drop when one stash commit has multiple reflog occurrences", async () => {
    const hash = "d".repeat(40);
    const newest = { ...entry("stash@{0}", hash, "duplicate"), occurrenceCount: 2 };
    const older = { ...entry("stash@{2}", hash, "duplicate"), occurrenceCount: 2 };
    const { bus, dependencies } = setup([
      newest,
      entry("stash@{1}", "1".repeat(40), "between"),
      older
    ]);

    for (const command of ["stash:pop", "stash:drop"] as const) {
      await expect(
        bus.dispatch(command, {
          worktreeId: "worktree-1",
          stashHash: hash
        })
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "ambiguous_stash" }
      });
    }
    expect(dependencies.pop).not.toHaveBeenCalled();
    expect(dependencies.drop).not.toHaveBeenCalled();

    await expect(
      bus.dispatch("stash:apply", {
        worktreeId: "worktree-1",
        stashHash: hash
      })
    ).resolves.toEqual(ok(null));
    expect(dependencies.apply).toHaveBeenCalledTimes(1);
  });

  it("keeps recovery metadata while inspecting an auto-stash", async () => {
    const recovery = entry(
      "stash@{0}",
      "a".repeat(40),
      PWRGIT_PULL_STASH_MESSAGE,
      "pwrgit-pull-recovery"
    );
    const { bus, dependencies } = setup([recovery]);

    await expect(
      bus.dispatch("stash:details", {
        worktreeId: "worktree-1",
        stashHash: recovery.hash
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { entry: { kind: "pwrgit-pull-recovery" } }
    });
    expect(dependencies.details).toHaveBeenCalledWith(
      dependencies.git,
      "/repos/project",
      recovery
    );
    await expect(
      bus.dispatch("diff:stash", {
        worktreeId: "worktree-1",
        stashHash: recovery.hash
      })
    ).resolves.toEqual(ok("patch"));
    expect(dependencies.patch).toHaveBeenCalledWith(
      dependencies.git,
      "/repos/project",
      recovery.hash
    );
  });

  it("announces both the conflicted worktree and kept stack after pop fails", async () => {
    const recovery = entry(
      "stash@{0}",
      "a".repeat(40),
      PWRGIT_PULL_STASH_MESSAGE,
      "pwrgit-pull-recovery"
    );
    const { bus, dependencies, refresher } = setup([recovery]);
    dependencies.pop.mockResolvedValueOnce(
      err({ kind: "git", code: "exit_1", message: "CONFLICT in README.md" })
    );

    await expect(
      bus.dispatch("stash:pop", {
        worktreeId: "worktree-1",
        stashHash: recovery.hash
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "exit_1" } });

    expect(emitEvent).toHaveBeenCalledWith("changes:changed", {
      worktreeId: "worktree-1"
    });
    expect(emitEvent).toHaveBeenCalledWith("stash:changed", {
      repoId: "repo-1"
    });
    expect(refresher.refreshWorktree).toHaveBeenCalledWith("worktree-1");
  });

  it("validates a named stash before invoking git", async () => {
    const { bus, dependencies } = setup([]);
    await expect(
      bus.dispatch("stash:create", {
        worktreeId: "worktree-1",
        message: "   ",
        includeUntracked: true
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "empty_stash_name" }
    });
    expect(dependencies.create).not.toHaveBeenCalled();
  });
});
