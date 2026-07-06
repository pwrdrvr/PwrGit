import {
  err,
  type CommandName,
  type PwrGitError,
  type Req,
  type Res,
  type Result
} from "@pwrgit/shared";

export type CommandContext = {
  signal?: AbortSignal;
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
      return (await handler(req, ctx)) as Result<Res<C>, PwrGitError>;
    } catch (cause) {
      return err({
        kind: "unknown",
        code: "handler_threw",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  }
}
