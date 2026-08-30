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

/** The two reads a renderer can have open. A pane shows one file one way, so
 *  one live read of each kind per renderer is the whole budget. */
type FileInsightKind = "history" | "blame" | "search";

type ActiveOperation = {
  operationId: string;
  controller: AbortController;
  /** Who may cancel this read, and whose next read supersedes it. */
  owner: string;
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

/**
 * Register cancellable file-insight reads.
 *
 * Each request owns a direct Git process, and this is the only place that
 * decides how many of those may exist: the renderer asks, main decides. Reads
 * are tracked per renderer AND KIND, not per operation id, so a second history
 * read supersedes the first rather than joining it. Keyed by operation id —
 * which is unique per request by construction — nothing capped anything, and a
 * renderer stuck in a retry loop had main spawning a Git process per iteration
 * for as long as it kept asking. A guard in the renderer is worth having, but
 * it cannot be the only one: this process owns process lifetime.
 */
export function registerFileInsightHandlers(
  bus: CommandBus,
  db: DB
): {
  releaseWebContents: (webContentsId: number) => void;
  liveReads: () => number;
} {
  const live = new Map<string, ActiveOperation>();
  const fileLists = createFileListCache();
  // A renderer is identified by its webContents id, which is all the ownership
  // CommandContext carries. Main-initiated calls have none and therefore share
  // one slot per kind: two of them would supersede and cancel each other.
  // Nothing dispatches these outside a renderer today, and giving each call its
  // own identity is not possible from here — CommandBus builds a fresh context
  // object per dispatch, so keying on it would stop a caller from cancelling
  // even its own read. Fixing it properly means an explicit owner on
  // CommandContext, which is a change to the shared protocol.
  const ownerId = (ctx: CommandContext): string =>
    ctx.webContentsId === undefined ? "local" : `wc-${ctx.webContentsId}`;
  const liveKey = (kind: FileInsightKind, ctx: CommandContext): string =>
    `${ownerId(ctx)}:${kind}`;
  const ownedBy = (operation: ActiveOperation, ctx: CommandContext): boolean =>
    operation.owner === ownerId(ctx);

  const pathOf = (worktreeId: string): string | null =>
    (
      db.prepare("SELECT path FROM worktrees WHERE id = ?").get(worktreeId) as
        | { path: string }
        | undefined
    )?.path ?? null;

  const begin = (
    kind: FileInsightKind,
    operationId: string,
    ctx: CommandContext
  ): { key: string; operation: ActiveOperation } | null => {
    if (!validOperationId(operationId)) return null;
    const key = liveKey(kind, ctx);
    // Whatever this renderer had open of this kind is now stale by definition.
    live.get(key)?.controller.abort();
    const operation: ActiveOperation = {
      operationId,
      controller: new AbortController(),
      owner: ownerId(ctx),
      ...(ctx.webContentsId === undefined
        ? {}
        : { webContentsId: ctx.webContentsId })
    };
    live.set(key, operation);
    return { key, operation };
  };

  // Only if it is still the current one: an older read finishing must not
  // evict the read that superseded it.
  const finish = (key: string, operation: ActiveOperation): void => {
    if (live.get(key) === operation) live.delete(key);
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
    const started = begin("history", req.operationId, ctx);
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
    const started = begin("blame", req.operationId, ctx);
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

  bus.register("file:search", async (req, ctx) => {
    const cwd = pathOf(req.worktreeId);
    if (cwd === null) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    if (req.query.trim() === "") return ok([]);
    // Bounded and cancellable like the other two reads: a window that closes
    // mid-read should not leave `ls-files` running for results nobody will see.
    // A fixed id, because search-as-you-type has no id of its own and needs
    // none — the per-renderer/kind key already makes the newest query supersede
    // the one it replaced, which is exactly what an abandoned keystroke wants.
    const started = begin("search", "file-search", ctx);
    if (started === null) return ok([]);
    const { key, operation } = started;
    let index;
    try {
      index = await fileLists.index(
        execGit,
        req.worktreeId,
        cwd,
        operation.controller.signal
      );
    } finally {
      finish(key, operation);
    }
    if (!index.ok) return index;
    const limit = Number.isFinite(req.limit)
      ? Math.max(1, Math.min(FILE_SEARCH_LIMIT_MAX, Math.trunc(req.limit ?? 0)))
      : FILE_SEARCH_LIMIT_DEFAULT;
    // Ranked here, never in the renderer: filtering only the rows already
    // fetched would silently hide matches that sort past the first page.
    return ok(rankIndexedPaths(index.value, req.query, limit));
  });

  bus.register("file:cancelInsight", (req, ctx) => {
    // At most two entries per renderer, so a scan is cheaper than a second
    // index — and a renderer may only cancel its own reads.
    for (const [key, operation] of live) {
      if (!ownedBy(operation, ctx)) continue;
      if (operation.operationId !== req.operationId) continue;
      operation.controller.abort();
      live.delete(key);
    }
    return ok(null);
  });

  return {
    releaseWebContents: (webContentsId) => {
      for (const [key, operation] of live) {
        if (operation.webContentsId !== webContentsId) continue;
        operation.controller.abort();
        live.delete(key);
      }
    },
    /** Live Git reads this process is holding — the cap this module enforces. */
    liveReads: () => live.size
  };
}
