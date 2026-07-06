// Result-pattern for cross-process error handling.
//
// Electron's `ipcRenderer.invoke` strips `instanceof Error` and reduces
// thrown errors to `{ message, name, stack }` — which loses any
// discriminator we'd dispatch on (`error.kind`, `error.code`). Instead every
// command-bus handler returns `Result<T, PwrGitError>` and the transport
// carries the typed error envelope directly. Nothing throws across the
// process boundary.

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = PwrGitError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export type PwrGitErrorKind =
  | "git" // git process failed (non-zero exit, parse error)
  | "repo" // repo/worktree discovery or lifecycle
  | "remote" // fetch/pull/push (network, credentials, non-fast-forward)
  | "rebase" // history-editing / rebase assistant
  | "agent" // agent-kit / Codex / ACP
  | "profile"
  | "settings"
  | "persistence"
  | "validation"
  | "unknown";

export type PwrGitError = {
  kind: PwrGitErrorKind;
  code: string;
  message: string;
  cause?: unknown;
};

export function pwrGitError(
  kind: PwrGitErrorKind,
  code: string,
  message: string,
  cause?: unknown
): PwrGitError {
  return cause === undefined
    ? { kind, code, message }
    : { kind, code, message, cause };
}
