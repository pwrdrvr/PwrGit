import { err, ok } from "@pwrgit/shared";
import type { CommandBus, CommandContext } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import { readFileBlame, readFileHistory } from "./file-insights";
import {
  createFileListCache,
  FILE_SEARCH_LIMIT_DEFAULT,
  FILE_SEARCH_LIMIT_MAX,
  rankIndexedPaths
} from "./file-search";

type ActiveOperation = {
  controller: AbortController;
  webContentsId?: number;
};

const validOperationId = (value: string): boolean =>
  /^[a-zA-Z0-9:_-]{1,128}$/.test(value);

/**
 * A cancelled read is an error, not a result.
 *
 * This used to answer an aborted blame with a synthetic page carrying
 * `unavailableReason: "missing"`, which renders as "This file does not exist
 * in the selected context." — a flat untruth about the user's file. The
 * renderer drops replies to operations it has already cancelled, so nothing
 * showed it today, and that is exactly what made it a trap for the next
 * caller.
 */
const canceled = () =>
  err({
    kind: "git" as const,
    code: "canceled",
    message: "The file-insight read was canceled."
  });

/** Register cancellable file-insight reads. Each request owns a direct Git
 *  process; replacing the view or destroying its renderer stops that process. */
export function registerFileInsightHandlers(
  bus: CommandBus,
  db: DB
): { releaseWebContents: (webContentsId: number) => void } {
  const active = new Map<string, ActiveOperation>();
  const fileLists = createFileListCache();
  const operationKey = (operationId: string, ctx: CommandContext): string =>
    `${ctx.webContentsId ?? "local"}:${operationId}`;

  const pathOf = (worktreeId: string): string | null =>
    (
      db.prepare("SELECT path FROM worktrees WHERE id = ?").get(worktreeId) as
        | { path: string }
        | undefined
    )?.path ?? null;

  const begin = (
    operationId: string,
    ctx: CommandContext
  ): { key: string; operation: ActiveOperation } | null => {
    if (!validOperationId(operationId)) return null;
    const key = operationKey(operationId, ctx);
    active.get(key)?.controller.abort();
    const operation: ActiveOperation = {
      controller: new AbortController(),
      ...(ctx.webContentsId === undefined
        ? {}
        : { webContentsId: ctx.webContentsId })
    };
    active.set(key, operation);
    return { key, operation };
  };

  const finish = (key: string, operation: ActiveOperation): void => {
    if (active.get(key) === operation) active.delete(key);
  };

  bus.register("file:history", async (req, ctx) => {
    const cwd = pathOf(req.worktreeId);
    if (cwd === null) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    const started = begin(req.operationId, ctx);
    if (started === null) {
      return err({
        kind: "validation",
        code: "invalid_operation_id",
        message: "A valid file-history operation id is required."
      });
    }
    const { key, operation } = started;
    try {
      const result = await readFileHistory(
        execGit,
        cwd,
        req,
        operation.controller.signal
      );
      return operation.controller.signal.aborted ? canceled() : result;
    } finally {
      finish(key, operation);
    }
  });

  bus.register("file:blame", async (req, ctx) => {
    const cwd = pathOf(req.worktreeId);
    if (cwd === null) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    const started = begin(req.operationId, ctx);
    if (started === null) {
      return err({
        kind: "validation",
        code: "invalid_operation_id",
        message: "A valid file-blame operation id is required."
      });
    }
    const { key, operation } = started;
    try {
      const result = await readFileBlame(
        execGit,
        cwd,
        req,
        operation.controller.signal
      );
      return operation.controller.signal.aborted ? canceled() : result;
    } finally {
      finish(key, operation);
    }
  });

  bus.register("file:search", async (req) => {
    const cwd = pathOf(req.worktreeId);
    if (cwd === null) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    if (req.query.trim() === "") return ok([]);
    const index = await fileLists.index(execGit, req.worktreeId, cwd);
    if (!index.ok) return index;
    const limit = Number.isFinite(req.limit)
      ? Math.max(1, Math.min(FILE_SEARCH_LIMIT_MAX, Math.trunc(req.limit ?? 0)))
      : FILE_SEARCH_LIMIT_DEFAULT;
    // Ranked here, never in the renderer: filtering only the rows already
    // fetched would silently hide matches that sort past the first page.
    return ok(rankIndexedPaths(index.value, req.query, limit));
  });

  bus.register("file:cancelInsight", (req, ctx) => {
    const key = operationKey(req.operationId, ctx);
    const operation = active.get(key);
    if (operation !== undefined) {
      operation.controller.abort();
      active.delete(key);
    }
    return ok(null);
  });

  return {
    releaseWebContents: (webContentsId) => {
      for (const [operationId, operation] of active) {
        if (operation.webContentsId !== webContentsId) continue;
        operation.controller.abort();
        active.delete(operationId);
      }
    }
  };
}
