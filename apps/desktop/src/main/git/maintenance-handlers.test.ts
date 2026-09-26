import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type MaintenanceAction,
  type MaintenanceSummary,
  type Result
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import {
  maintenanceRepos,
  registerMaintenanceHandlers
} from "./maintenance-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

let root: string;
let db: DB;
let bus: CommandBus;
let git: ReturnType<typeof vi.fn<GitExec>>;
let handlers: ReturnType<typeof registerMaintenanceHandlers>;
let operations: WorktreeOperationQueue;
const gc: MaintenanceAction = { kind: "gc", mode: "standard" };
const output = (stdout = "", exitCode = 0) =>
  ok({ stdout, stderr: "", exitCode });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-maintenance-handlers-"));
  db = openDatabase(":memory:");
  db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(
    "one",
    "One",
    "one@example.test"
  );
  db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(
    "two",
    "Two",
    "two@example.test"
  );
  for (const [id, profile] of [
    ["a", "one"],
    ["b", "one"],
    ["c", "two"]
  ]) {
    const path = join(root, id!);
    mkdirSync(join(path, ".git"), { recursive: true });
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
    ).run(id, profile, id, path);
  }
  git = vi.fn<GitExec>(async (args, cwd) => {
    if (args[0] === "rev-parse") return output(join(cwd, ".git"));
    if (args[0] === "count-objects") return output("size: 32\nsize-pack: 64\n");
    return output();
  });
  bus = new CommandBus();
  operations = new WorktreeOperationQueue();
  handlers = registerMaintenanceHandlers(bus, db, git, operations, {
    refreshRepoWorktrees: vi.fn()
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function value(result: Result<MaintenanceSummary>): MaintenanceSummary {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("maintenance lifecycle and profile scope", () => {
  it("limits runs to this profile unless all profiles is requested", async () => {
    expect(
      maintenanceRepos(db, { profileId: "one" })?.map((repo) => repo.id)
    ).toEqual(["a", "b"]);
    const first = value(
      await bus.dispatch("maintenance:run", {
        profileId: "one",
        operationId: "first",
        action: gc
      })
    );
    expect(first.results.map((result) => result.repo.id)).toEqual(["a", "b"]);
    expect(git.mock.calls.some(([, cwd]) => cwd === join(root, "c"))).toBe(
      false
    );
    const second = value(
      await bus.dispatch("maintenance:run", {
        profileId: "one",
        allProfiles: true,
        operationId: "second",
        action: gc
      })
    );
    expect(second.results.map((result) => result.repo.id)).toEqual([
      "a",
      "b",
      "c"
    ]);
    expect(emitEvent).toHaveBeenCalledWith(
      "maintenance:progress",
      expect.objectContaining({
        operationId: "first",
        profileId: "one",
        phase: "starting"
      })
    );
  });

  it("reports a failed repository and continues, de-duplicating shared object stores", async () => {
    git.mockImplementation(async (args, cwd) => {
      if (args[0] === "rev-parse")
        return output(join(root, cwd.endsWith("b") ? "b" : "a", ".git"));
      if (args.includes("gc") && cwd.endsWith("b")) return output("", 1);
      return output();
    });
    const summary = value(
      await bus.dispatch("maintenance:run", {
        profileId: "one",
        allProfiles: true,
        operationId: "run",
        action: gc
      })
    );
    expect(summary.results.map((result) => result.outcome)).toEqual([
      "success",
      "failed",
      "skipped"
    ]);
    expect(git.mock.calls.filter(([args]) => args.includes("gc"))).toHaveLength(
      2
    );
  });

  it("bounds runs across windows and waits for active GC before honouring owner cancellation", async () => {
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = git.getMockImplementation()!;
    git.mockImplementation(async (args, cwd, opts) => {
      if (args.includes("gc")) {
        started();
        await gate;
      }
      return original(args, cwd, opts);
    });
    const pending = bus.dispatch(
      "maintenance:run",
      { profileId: "one", operationId: "run", action: gc },
      { webContentsId: 1 }
    );
    await began;
    expect(
      (
        await bus.dispatch(
          "maintenance:run",
          { profileId: "two", operationId: "other", action: gc },
          { webContentsId: 2 }
        )
      ).ok
    ).toBe(false);
    expect(
      await bus.dispatch(
        "maintenance:cancel",
        { operationId: "run" },
        { webContentsId: 2 }
      )
    ).toEqual(ok({ cancelled: false }));
    expect(
      await bus.dispatch(
        "maintenance:cancel",
        { operationId: "run" },
        { webContentsId: 1 }
      )
    ).toEqual(ok({ cancelled: true }));
    finish();
    const summary = value(await pending);
    expect(summary.cancelled).toBe(true);
    expect(summary.results.map((result) => result.outcome)).toEqual([
      "success",
      "cancelled"
    ]);
    expect(git.mock.calls.filter(([args]) => args.includes("gc"))).toHaveLength(
      1
    );
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "two",
          operationId: "next",
          action: gc
        })
      ).ok
    ).toBe(true);
  });

  it("does not launch Git after the owning window closes while waiting for the repository lock", async () => {
    let release!: () => void;
    const locked = operations.runRepository(
      "a",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await Promise.resolve();
    const pending = bus.dispatch(
      "maintenance:run",
      { profileId: "one", operationId: "run", action: gc },
      { webContentsId: 7 }
    );
    handlers.releaseWebContents(7);
    release();
    await locked;
    expect(
      value(await pending).results.every(
        (result) => result.outcome === "cancelled"
      )
    ).toBe(true);
    expect(git).not.toHaveBeenCalled();
  });

  it("refuses branch deletion outside the chosen profile and invalid options before Git runs", async () => {
    const branch = {
      repoId: "c",
      branch: "old",
      expectedHead: "abc",
      upstream: "refs/remotes/origin/old"
    };
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "one",
          operationId: "run",
          action: { kind: "delete-branches", branches: [branch] }
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "one",
          operationId: "run",
          action: { kind: "gc", mode: "bad" } as unknown as MaintenanceAction
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "unknown",
          operationId: "run",
          action: gc
        })
      ).ok
    ).toBe(false);
    expect(git).not.toHaveBeenCalled();
  });
});
