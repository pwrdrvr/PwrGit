/** A read is either still pending, usable, or failed with a retryable reason. */
export type ReadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

export const LOADING_READ_STATE: ReadState = { status: "loading" };
export const READY_READ_STATE: ReadState = { status: "ready" };
