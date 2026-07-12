import type {
  CommandName,
  EventChannel,
  EventPayload,
  PwrGitError,
  Req,
  Res,
  Result
} from "@pwrgit/shared";

type PwrGitBridge = {
  /** The profile this window is bound to (one window per profile). */
  profileId: string | null;
  dispatch: (name: string, req: unknown) => Promise<unknown>;
  on: (channel: string, handler: (payload: unknown) => void) => () => void;
};

declare global {
  interface Window {
    pwrgit: PwrGitBridge;
  }
}

/** The profile this window was opened for (null only in dev edge cases). */
export function windowProfileId(): string | null {
  return window.pwrgit.profileId ?? null;
}

/** Typed command dispatch. Returns a Result — never throws for command errors. */
export function dispatch<C extends CommandName>(
  name: C,
  req: Req<C>
): Promise<Result<Res<C>, PwrGitError>> {
  return window.pwrgit.dispatch(name, req) as Promise<
    Result<Res<C>, PwrGitError>
  >;
}

export class PwrGitDispatchError extends Error {
  readonly error: PwrGitError;
  constructor(error: PwrGitError) {
    super(`${error.kind}/${error.code}: ${error.message}`);
    this.name = "PwrGitDispatchError";
    this.error = error;
  }
}

/** Dispatch and unwrap the value, throwing PwrGitDispatchError on an err Result. */
export async function dispatchOrThrow<C extends CommandName>(
  name: C,
  req: Req<C>
): Promise<Res<C>> {
  const result = await dispatch(name, req);
  if (!result.ok) throw new PwrGitDispatchError(result.error);
  return result.value;
}

/** Subscribe to a server event channel. Returns an unsubscribe function. */
export function subscribe<C extends EventChannel>(
  channel: C,
  handler: (payload: EventPayload<C>) => void
): () => void {
  return window.pwrgit.on(channel, handler as (payload: unknown) => void);
}
