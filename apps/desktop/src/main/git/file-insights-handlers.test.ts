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
