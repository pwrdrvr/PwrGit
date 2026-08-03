import {
  err,
  type CommandName,
  type PwrGitError,
  type Req,
  type Res,
  type Result
} from "@pwrgit/shared";
import { logMain } from "./logs";

export type CommandContext = {
  signal?: AbortSignal;
  /** Electron sender identity; absent for local/test transports. */
  webContentsId?: number;
};

export type CommandHandler<C extends CommandName> = (
  req: Req<C>,
  ctx: CommandContext
) => Promise<Result<Res<C>, PwrGitError>> | Result<Res<C>, PwrGitError>;

// Handlers are stored behind a loose signature and re-narrowed at the typed
// public boundary. This is the standard escape hatch for a per-key
// request/response map — `register`/`dispatch` stay fully typed for callers.
type AnyHandler = (
  req: unknown,
  ctx: CommandContext
) => Promise<Result<unknown, PwrGitError>> | Result<unknown, PwrGitError>;

/**
 * Single dispatcher for every command. One registration point in main; the
 * renderer reaches it over IPC (and future HTTP/MCP transports could reuse it
 * unchanged). Every handler returns a `Result` — nothing throws across the
 * transport boundary.
 */
export class CommandBus {
  private readonly handlers = new Map<CommandName, AnyHandler>();

  register<C extends CommandName>(name: C, handler: CommandHandler<C>): void {
    this.handlers.set(name, handler as AnyHandler);
  }

  async dispatch<C extends CommandName>(
    name: C,
    req: Req<C>,
    ctx: CommandContext = {}
  ): Promise<Result<Res<C>, PwrGitError>> {
    const handler = this.handlers.get(name);
    if (handler === undefined) {
      return err({
        kind: "unknown",
        code: "no_handler",
        message: `No handler registered for command "${String(name)}"`
      });
    }
    try {
      const result = (await handler(req, ctx)) as Result<Res<C>, PwrGitError>;
      // Every command failure lands in the app log — the renderer may render
      // errors small (or not at all); the Logs window must still have them.
      if (!result.ok) {
        logMain(
          "error",
          "command",
          `${String(name)} failed:`,
          `${result.error.kind}/${result.error.code}`,
          result.error.message
        );
      }
      return result;
    } catch (cause) {
      logMain("error", "command", `${String(name)} threw:`, cause);
      return err({
        kind: "unknown",
        code: "handler_threw",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  }
}
