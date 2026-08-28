import { spawn, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";

/**
 * Generic hardened runner for a forge's command-line client.
 *
 * This is `gh-cli.ts` with everything brand-specific lifted into a `CliSpec`,
 * so `gh` and `glab` share one audited implementation instead of two copies
 * that drift. The security-relevant behavior — no inherited TTY, no prompt,
 * bounded output, and credentials never reaching a diagnostic — is identical
 * for both, and is what `gh-cli.test.ts` exercises.
 */
export type CliSpec = {
  /** Executable name, spawned from PATH. */
  binary: string;
  /** Human label used in error text, e.g. "GitHub CLI". */
  label: string;
  /** `Error.name` this CLI's failures carry, e.g. "GhCliError". */
  errorName: string;
  /** Shown whenever a failure is classified as an auth problem. */
  authenticationRequiredMessage: string;
  /** Env that must win over any caller override, to keep prompts closed. */
  nonInteractiveEnv: Readonly<Record<string, string>>;
  /** Env vars whose literal values must never appear in a diagnostic. */
  sensitiveEnvNames: readonly string[];
  /** Token prefixes, used to avoid re-forming a secret across a truncation. */
  tokenPrefixes: readonly string[];
  /** Redaction patterns applied to every diagnostic. */
  redactionPatterns: readonly { pattern: RegExp; replacement: string }[];
  /** Extra auth-failure phrasing unique to this CLI. */
  authenticationHints: readonly RegExp[];
};

// Electron's PATH may miss Homebrew etc. in a packaged app; augment it so the
// CLI resolves the way it does in the user's shell.
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_STREAM_TAIL_CHARS = 64 * 1024;
const MAX_PENDING_STREAM_STDERR_CHARS = 64 * 1024;
const MIN_STREAM_REDACTION_OVERLAP_CHARS = 4 * 1024;
const TOKEN_BOUNDARY_LOOKBEHIND_CHARS = 1024;
const FORCE_KILL_DELAY_MS = 1_000;

/** Auth phrasing every forge CLI and the git credential helpers share. */
const SHARED_AUTHENTICATION_PATTERN =
  /(?:authentication (?:is )?required|authentication failed|bad credentials|not logged (?:in|into)|http 401|status code 401|terminal prompts disabled|could not read (?:username|password)|no credentials (?:found|available)|permission denied \(publickey\))/i;
/** Both supported forges hide inaccessible private repositories behind the
 *  same 404 used for a misspelled path. */
const SHARED_NOT_FOUND_PATTERN =
  /(?:\bhttp\s*404\b|\bstatus(?:\s+code)?\s*:?[ \t]*404\b|\b404\s+(?:project\s+)?not found\b)/i;

export type CliRunOptions = {
  timeoutMs?: number;
  /** Receive sanitized stderr chunks while retaining only a bounded tail. */
  onStderr?: (chunk: string) => void;
  env?: Record<string, string | undefined>;
  /** Abort the CLI and its detached process group. */
  signal?: AbortSignal;
};

export type CliErrorCode =
  | "authentication_required"
  | "aborted"
  | "timed_out"
  | "output_too_large"
  | "command_failed";

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: CliErrorCode,
    readonly stdout: string,
    readonly stderr: string,
    name = "CliError"
  ) {
    super(message);
    this.name = name;
  }
}

/** One CLI's bound entry points, so callers never pass the spec around. */
export type CliClient = {
  spec: CliSpec;
  environment(): NodeJS.ProcessEnv;
  sanitize(diagnostic: string, environment?: NodeJS.ProcessEnv): string;
  isAuthenticationError(cause: unknown): boolean;
  isNotFoundError(cause: unknown): boolean;
  errorMessage(cause: unknown): string;
  run(args: string[], options?: CliRunOptions): Promise<string>;
};

export function createCliClient(spec: CliSpec): CliClient {
  const environment = (): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":"),
    ...spec.nonInteractiveEnv
  });

  const environmentWith = (
    overrides: CliRunOptions["env"]
  ): NodeJS.ProcessEnv => ({
    ...environment(),
    ...overrides,
    // A caller may add locale or command-specific values, but no GUI call may
    // opt back into a prompt that can open the inherited controlling TTY.
    ...spec.nonInteractiveEnv
  });

  const secretValues = (env: NodeJS.ProcessEnv): string[] =>
    spec.sensitiveEnvNames
      .map((name) => env[name]?.trim())
      .filter((value): value is string => value !== undefined && value.length >= 4)
      .sort((a, b) => b.length - a.length);

  /** Keep CLI diagnostics useful without allowing credentials into UI errors. */
  const sanitize = (
    diagnostic: string,
    env: NodeJS.ProcessEnv = environment()
  ): string => {
    let sanitized = diagnostic;
    for (const secret of secretValues(env)) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
    for (const { pattern, replacement } of spec.redactionPatterns) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized;
  };

  const authenticationRequired = (diagnostic: string): boolean =>
    SHARED_AUTHENTICATION_PATTERN.test(diagnostic) ||
    spec.authenticationHints.some((pattern) => pattern.test(diagnostic));

  const isAuthenticationError = (cause: unknown): boolean => {
    if (cause instanceof CliError) return cause.code === "authentication_required";
    if (!(cause instanceof Error)) return false;
    const failure = cause as Error & { stdout?: string; stderr?: string };
    return authenticationRequired(
      `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
    );
  };

  const isNotFoundError = (cause: unknown): boolean => {
    if (!(cause instanceof Error)) return false;
    const failure = cause as Error & { stdout?: string; stderr?: string };
    return SHARED_NOT_FOUND_PATTERN.test(
      `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
    );
  };

  const errorMessage = (cause: unknown): string => {
    if (isAuthenticationError(cause)) return spec.authenticationRequiredMessage;
    if (!(cause instanceof Error)) return sanitize(String(cause));
    const failure = cause as Error & { stderr?: string };
    return sanitize(failure.stderr?.trim() || cause.message);
  };

  const cliError = (
    message: string,
    code: CliErrorCode,
    stdout: string,
    stderr: string
  ): CliError => new CliError(message, code, stdout, stderr, spec.errorName);

  const failure = (
    cause: unknown,
    stdout: string,
    stderr: string,
    env: NodeJS.ProcessEnv,
    timedOutMessage?: string
  ): CliError => {
    const safeStdout = sanitize(stdout, env);
    const safeStderr = sanitize(stderr, env);
    const causeMessage =
      cause instanceof Error ? sanitize(cause.message, env) : "";
    const diagnostic = `${causeMessage}\n${safeStdout}\n${safeStderr}`;
    if (timedOutMessage !== undefined) {
      return cliError(timedOutMessage, "timed_out", safeStdout, safeStderr);
    }
    if (authenticationRequired(diagnostic)) {
      return cliError(
        spec.authenticationRequiredMessage,
        "authentication_required",
        safeStdout,
        safeStderr
      );
    }
    return cliError(
      safeStderr.trim() || causeMessage || `${spec.label} command failed.`,
      "command_failed",
      safeStdout,
      safeStderr
    );
  };

  const protectTokenBoundary = (
    diagnostic: string,
    proposedCut: number
  ): number => {
    const windowStart = Math.max(0, proposedCut - TOKEN_BOUNDARY_LOOKBEHIND_CHARS);
    const beforeCut = diagnostic.slice(windowStart, proposedCut);
    let protectedCut = proposedCut;
    for (const prefix of spec.tokenPrefixes) {
      const tokenStart = beforeCut.lastIndexOf(prefix);
      if (
        tokenStart >= 0 &&
        /^[A-Za-z0-9_-]*$/.test(beforeCut.slice(tokenStart + prefix.length))
      ) {
        protectedCut = Math.min(protectedCut, windowStart + tokenStart);
      }
      for (let prefixLength = 1; prefixLength < prefix.length; prefixLength += 1) {
        if (beforeCut.endsWith(prefix.slice(0, prefixLength))) {
          protectedCut = Math.min(protectedCut, proposedCut - prefixLength);
        }
      }
    }
    return protectedCut;
  };

  const sanitizeTruncated = (
    diagnostic: string,
    env: NodeJS.ProcessEnv
  ): string => {
    let safeEnd = protectTokenBoundary(diagnostic, diagnostic.length);
    for (const secret of secretValues(env)) {
      // The retained bytes may end at any point inside this exact value.
      // Dropping one value-length from the boundary guarantees that a partial
      // suffix is never surfaced; complete values before that boundary are
      // redacted below.
      safeEnd = Math.min(safeEnd, Math.max(0, diagnostic.length - secret.length));
    }
    return sanitize(diagnostic.slice(0, safeEnd), env);
  };

  const outputTooLargeFailure = (
    stream: "stdout" | "stderr",
    stdout: string,
    stderr: string,
    env: NodeJS.ProcessEnv
  ): CliError =>
    cliError(
      `${spec.label} ${stream} exceeded the ${MAX_BUFFER_BYTES}-byte limit.`,
      "output_too_large",
      stream === "stdout"
        ? sanitizeTruncated(stdout, env)
        : sanitize(stdout, env),
      stream === "stderr"
        ? sanitizeTruncated(stderr, env)
        : sanitize(stderr, env)
    );

  const run = (args: string[], options: CliRunOptions = {}): Promise<string> => {
    const abortedFailure = (): CliError =>
      cliError(
        `${spec.label} command was canceled.`,
        "aborted",
        "",
        ""
      );
    if (options.signal?.aborted === true) {
      return Promise.reject(abortedFailure());
    }
    return new Promise((resolve, reject) => {
      const env = environmentWith(options.env);
      const child = spawn(spec.binary, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // On POSIX this starts a new session without the GUI's inherited
        // controlling terminal. It covers Git/SSH askpass behavior without
        // replacing the user's SSH command or configuration.
        detached: process.platform !== "win32",
        windowsHide: true
      });
      let stdoutTail = "";
      let stderrTail = "";
      let pendingStreamStderr = "";
      let redactPendingStreamStderr = false;
      let settled = false;
      let terminationReason:
        | { kind: "timed_out" }
        | { kind: "aborted" }
        | { kind: "output_too_large"; stream: "stdout" | "stderr" }
        | undefined;
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const streamLimit =
        options.onStderr === undefined ? MAX_BUFFER_BYTES : MAX_STREAM_TAIL_CHARS;
      const timeoutMs = options.timeoutMs ?? 10_000;
      const timeout = setTimeout(
        () => beginTermination({ kind: "timed_out" }),
        timeoutMs
      );

      const rejectOnce = (cause: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
        reject(cause);
      };

      const terminationFailure = (): CliError => {
        if (terminationReason?.kind === "output_too_large") {
          return outputTooLargeFailure(
            terminationReason.stream,
            stdoutTail,
            stderrTail,
            env
          );
        }
        if (terminationReason?.kind === "aborted") return abortedFailure();
        return failure(
          new Error(`${spec.label} did not exit before its timeout.`),
          stdoutTail,
          stderrTail,
          env,
          `${spec.binary} timed out after ${timeoutMs}ms`
        );
      };

      const beginTermination = (
        reason: NonNullable<typeof terminationReason>
      ): void => {
        if (terminationReason !== undefined || settled) return;
        terminationReason = reason;
        clearTimeout(timeout);
        terminateChild(child, "SIGTERM");
        forceKillTimeout = setTimeout(() => {
          terminateChild(child, "SIGKILL");
          flushStreamingStderr();
          rejectOnce(terminationFailure());
        }, FORCE_KILL_DELAY_MS);
      };
      const onAbort = (): void => beginTermination({ kind: "aborted" });
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const flushStreamingStderr = (complete = true): void => {
        if (options.onStderr === undefined || pendingStreamStderr === "") return;
        let emitLength = pendingStreamStderr.length;
        let replaceEmittedDiagnostic = false;
        if (!complete) {
          emitLength =
            Math.max(
              pendingStreamStderr.lastIndexOf("\n"),
              pendingStreamStderr.lastIndexOf("\r")
            ) + 1;
          if (
            emitLength === 0 &&
            pendingStreamStderr.length > MAX_PENDING_STREAM_STDERR_CHARS
          ) {
            const longestSecret = secretValues(env).reduce(
              (longest, secret) => Math.max(longest, secret.length),
              0
            );
            const overlap = Math.min(
              MAX_PENDING_STREAM_STDERR_CHARS / 2,
              Math.max(MIN_STREAM_REDACTION_OVERLAP_CHARS, longestSecret + 64)
            );
            emitLength = pendingStreamStderr.length - overlap;
            emitLength = protectTokenBoundary(pendingStreamStderr, emitLength);
            for (const secret of secretValues(env)) {
              const start = pendingStreamStderr.lastIndexOf(secret, emitLength - 1);
              if (
                start >= 0 &&
                start < emitLength &&
                start + secret.length > emitLength
              ) {
                emitLength = start;
              }
            }
            if (emitLength === 0) {
              // An unusually large caller-provided secret can be longer than
              // the carry window. Drop its emitted prefix as one redaction
              // marker so memory remains bounded without reconstructing the
              // secret later.
              emitLength =
                pendingStreamStderr.length - MAX_PENDING_STREAM_STDERR_CHARS / 2;
              replaceEmittedDiagnostic = true;
              redactPendingStreamStderr = true;
            }
          }
        }
        if (emitLength === 0) return;
        const diagnostic = pendingStreamStderr.slice(0, emitLength);
        pendingStreamStderr = pendingStreamStderr.slice(emitLength);
        options.onStderr(
          replaceEmittedDiagnostic || redactPendingStreamStderr
            ? "[REDACTED]"
            : sanitize(diagnostic, env)
        );
        if (complete || /[\r\n]/.test(diagnostic)) {
          redactPendingStreamStderr = false;
        }
        if (
          !complete &&
          pendingStreamStderr.length > MAX_PENDING_STREAM_STDERR_CHARS
        ) {
          flushStreamingStderr(false);
        }
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        // Successful stdout is the API result. In particular, `auth token`
        // intentionally returns a credential to the in-process token client.
        // It is sanitized only if the command fails and becomes diagnostic data.
        const text = chunk.toString();
        if (options.onStderr === undefined) {
          stdoutBytes += Buffer.byteLength(text);
          stdoutTail = appendWithinByteLimit(stdoutTail, text, streamLimit);
          if (stdoutBytes > streamLimit) {
            beginTermination({ kind: "output_too_large", stream: "stdout" });
          }
        } else {
          stdoutTail = appendTail(stdoutTail, text, streamLimit);
        }
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (options.onStderr === undefined) {
          stderrBytes += Buffer.byteLength(text);
          stderrTail = appendWithinByteLimit(stderrTail, text, streamLimit);
          if (stderrBytes > streamLimit) {
            beginTermination({ kind: "output_too_large", stream: "stderr" });
          }
        } else {
          stderrTail = appendTail(stderrTail, text, streamLimit);
          pendingStreamStderr += text;
          flushStreamingStderr(false);
        }
      });
      child.once("error", (error) => {
        flushStreamingStderr();
        rejectOnce(
          terminationReason === undefined
            ? failure(error, stdoutTail, stderrTail, env)
            : terminationFailure()
        );
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        flushStreamingStderr();
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
        if (exitCode === 0 && terminationReason === undefined) {
          resolve(stdoutTail.trim());
          return;
        }
        if (terminationReason !== undefined) {
          reject(terminationFailure());
          return;
        }
        reject(
          failure(
            new Error(
              stderrTail.trim() ||
                `${spec.binary} exited ${
                  exitCode ?? `after signal ${signal ?? "unknown"}`
                }`
            ),
            stdoutTail,
            stderrTail,
            env
          )
        );
      });
    });
  };

  return {
    spec,
    environment,
    sanitize,
    isAuthenticationError,
    isNotFoundError,
    errorMessage,
    run
  };
}

function appendTail(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return combined.length <= limit ? combined : combined.slice(-limit);
}

function appendWithinByteLimit(
  current: string,
  chunk: string,
  limit: number
): string {
  const remaining = limit - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  return current + Buffer.from(chunk).subarray(0, remaining).toString("utf8");
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    // Node's ChildProcess.kill() terminates only the CLI process on Windows.
    // gh/glab launch Git and credential/SSH helpers beneath it, so leaving the
    // descendants alive lets a canceled clone keep writing into a destination
    // while the service is trying to remove it. taskkill /T is Windows' native
    // process-tree operation; /F is required because Windows has no POSIX-like
    // graceful signal that propagates through this tree.
    try {
      const windowsRoot =
        process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      const taskkill = spawn(
        win32.join(windowsRoot, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      );
      let fellBack = false;
      const fallback = (): void => {
        if (fellBack) return;
        fellBack = true;
        killChildHandle(child, signal);
      };
      taskkill.once("error", fallback);
      taskkill.once("close", (code) => {
        if (code !== 0) fallback();
      });
      return;
    } catch {
      // A synchronous spawn failure still gets the best available fallback.
      killChildHandle(child, signal);
      return;
    }
  }

  // Detached POSIX children own a process group, so kill the CLI and any
  // Git/SSH helpers together. This also prevents an inherited Terminal from
  // becoming their TTY.
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may have already exited; fall through to the child handle.
    }
  }
  killChildHandle(child, signal);
}

function killChildHandle(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // A close/error event, or the force-kill timer, will settle the operation.
  }
}
