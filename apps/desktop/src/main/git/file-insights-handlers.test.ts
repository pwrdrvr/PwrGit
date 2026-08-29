import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";

const { execGit, readFileBlame, readFileHistory } = vi.hoisted(() => ({
  execGit: vi.fn(),
  readFileBlame: vi.fn(),
  readFileHistory: vi.fn()
}));

vi.mock("./dugite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dugite")>()),
  execGit
}));
vi.mock("./file-insights", () => ({ readFileBlame, readFileHistory }));

import { registerFileInsightHandlers } from "./file-insights-handlers";

const OPERATION = "file-blame-1-1";

/** Only `SELECT path FROM worktrees` is ever asked of the database here. */
const dbWith = (path: string | null): DB =>
  ({
    prepare: () => ({ get: () => (path === null ? undefined : { path }) })
  }) as unknown as DB;

const listing = (paths: string[]) =>
  Promise.resolve(
    ok({ stdout: paths.map((p) => `${p}\0`).join(""), stderr: "", exitCode: 0 })
  );

describe("file-insight handlers", () => {
  it("reports a canceled read as an error, not as a missing file", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    readFileBlame.mockImplementation(async () => {
      await blocked;
      return ok({
        path: "src/app.ts",
        effectiveContext: { kind: "workingTree" },
        hunks: [],
        nextCursor: null,
        bytes: 0
      });
    });

    const bus = new CommandBus();
    registerFileInsightHandlers(bus, dbWith("/repo"));
    const pending = bus.dispatch("file:blame", {
      operationId: OPERATION,
      worktreeId: "wt-1",
      path: "src/app.ts",
      context: { kind: "workingTree" }
    });

    await bus.dispatch("file:cancelInsight", { operationId: OPERATION });
    release?.();
    const result = await pending;

    // The old answer was a synthetic page reading "This file does not exist in
    // the selected context." — a flat untruth about the user's file.
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "git",
        code: "canceled",
        message: "The file-insight read was canceled."
      }
    });
  });

  it("aborts a renderer's reads when its web contents go away", async () => {
    const seen: AbortSignal[] = [];
    readFileHistory.mockImplementation(
      (_git: unknown, _cwd: string, _req: unknown, signal: AbortSignal) => {
        seen.push(signal);
        return new Promise(() => undefined);
      }
    );

    const bus = new CommandBus();
    const handlers = registerFileInsightHandlers(bus, dbWith("/repo"));
    void bus.dispatch(
      "file:history",
      {
        operationId: "file-history-1-1",
        worktreeId: "wt-1",
        path: "src/app.ts",
        context: { kind: "workingTree" }
      },
      { webContentsId: 7 }
    );
    await Promise.resolve();

    expect(seen[0]?.aborted).toBe(false);
    handlers.releaseWebContents(7);
    expect(seen[0]?.aborted).toBe(true);
  });

  it("refuses an operation id that could not have come from a renderer", async () => {
    const bus = new CommandBus();
    registerFileInsightHandlers(bus, dbWith("/repo"));
    const result = await bus.dispatch("file:history", {
      operationId: "../../etc/passwd",
      worktreeId: "wt-1",
      path: "src/app.ts",
      context: { kind: "workingTree" }
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "invalid_operation_id" }
    });
  });

  it("ranks file search in the main process and answers an empty query cheaply", async () => {
    execGit.mockImplementation(() =>
      listing(["src/App.tsx", "src/legacy/App.tsx", "README.md"])
    );
    const bus = new CommandBus();
    registerFileInsightHandlers(bus, dbWith("/repo"));

    const empty = await bus.dispatch("file:search", {
      worktreeId: "wt-1",
      query: "   "
    });
    expect(empty).toEqual(ok([]));
    expect(execGit).not.toHaveBeenCalled();

    const hits = await bus.dispatch("file:search", {
      worktreeId: "wt-1",
      query: "App.tsx"
    });
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(hits.value.map((hit) => hit.path)).toEqual([
      "src/App.tsx",
      "src/legacy/App.tsx"
    ]);
  });

  it("says which worktree is missing rather than shelling out", async () => {
    execGit.mockClear();
    const bus = new CommandBus();
    registerFileInsightHandlers(bus, dbWith(null));
    const result = await bus.dispatch("file:search", {
      worktreeId: "gone",
      query: "App"
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "repo", code: "not_found" }
    });
    expect(execGit).not.toHaveBeenCalled();
  });
});

describe("how many Git processes a renderer can hold open", () => {
  /** A read that never settles, so every one started stays live. */
  const neverSettles = (seen: AbortSignal[]) =>
    (_git: unknown, _cwd: string, _req: unknown, signal: AbortSignal) => {
      seen.push(signal);
      return new Promise(() => undefined);
    };

  it("holds one live read per kind however many times a renderer asks", async () => {
    const seen: AbortSignal[] = [];
    readFileHistory.mockImplementation(neverSettles(seen));
    const bus = new CommandBus();
    const handlers = registerFileInsightHandlers(bus, dbWith("/repo"));

    // A renderer stuck in a retry loop. Keyed by operation id this accumulated
    // one live Git process per iteration.
    for (let i = 0; i < 25; i += 1) {
      void bus.dispatch(
        "file:history",
        {
          operationId: `file-history-${i}`,
          worktreeId: "wt-1",
          path: "src/app.ts",
          context: { kind: "workingTree" }
        },
        { webContentsId: 1 }
      );
      await Promise.resolve();
    }

    expect(handlers.liveReads()).toBe(1);
    // Every superseded read was aborted; only the newest is still running.
    expect(seen).toHaveLength(25);
    expect(seen.filter((signal) => !signal.aborted)).toHaveLength(1);
    expect(seen[24]?.aborted).toBe(false);
  });

  it("lets history and blame run at once, and one renderer per pane", async () => {
    const history: AbortSignal[] = [];
    const blame: AbortSignal[] = [];
    readFileHistory.mockImplementation(neverSettles(history));
    readFileBlame.mockImplementation(neverSettles(blame));
    const bus = new CommandBus();
    const handlers = registerFileInsightHandlers(bus, dbWith("/repo"));

    const req = (path: string) => ({
      operationId: `op-${path}`,
      worktreeId: "wt-1",
      path,
      context: { kind: "workingTree" as const }
    });
    void bus.dispatch("file:history", req("a"), { webContentsId: 1 });
    void bus.dispatch("file:blame", req("b"), { webContentsId: 1 });
    void bus.dispatch("file:history", req("c"), { webContentsId: 2 });
    await Promise.resolve();

    // Two kinds for renderer 1, one for renderer 2 — none supersede.
    expect(handlers.liveReads()).toBe(3);
    expect(history[0]?.aborted).toBe(false);
    expect(blame[0]?.aborted).toBe(false);

    // A second renderer's cancel may not reach the first renderer's read.
    await bus.dispatch(
      "file:cancelInsight",
      { operationId: "op-a" },
      { webContentsId: 2 }
    );
    expect(history[0]?.aborted).toBe(false);
    expect(handlers.liveReads()).toBe(3);

    await bus.dispatch(
      "file:cancelInsight",
      { operationId: "op-a" },
      { webContentsId: 1 }
    );
    expect(history[0]?.aborted).toBe(true);
    expect(handlers.liveReads()).toBe(2);
  });

  it("does not let a finishing read evict the one that replaced it", async () => {
    const settle: ((value: unknown) => void)[] = [];
    readFileHistory.mockImplementation(
      () => new Promise((resolve) => settle.push(resolve))
    );
    const bus = new CommandBus();
    const handlers = registerFileInsightHandlers(bus, dbWith("/repo"));

    const req = (id: string) => ({
      operationId: id,
      worktreeId: "wt-1",
      path: "src/app.ts",
      context: { kind: "workingTree" as const }
    });
    void bus.dispatch("file:history", req("first"), { webContentsId: 1 });
    await Promise.resolve();
    void bus.dispatch("file:history", req("second"), { webContentsId: 1 });
    await Promise.resolve();

    // The superseded read settles last; the live entry must still be "second".
    settle[0]?.(ok({ entries: [], nextCursor: null }));
    await Promise.resolve();
    await Promise.resolve();
    expect(handlers.liveReads()).toBe(1);
  });
});
