import { spawn, type ChildProcess } from "node:child_process";

// Electron's PATH may miss Homebrew etc. in a packaged app; augment it so `gh`
// resolves the way it does in the user's shell.
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_STREAM_TAIL_CHARS = 64 * 1024;
const MAX_PENDING_STREAM_STDERR_CHARS = 64 * 1024;
const MIN_STREAM_REDACTION_OVERLAP_CHARS = 4 * 1024;
const TOKEN_BOUNDARY_LOOKBEHIND_CHARS = 1024;
const GITHUB_TOKEN_PREFIXES = [
  "github_pat_",
  "gho_",
  "ghp_",
  "ghu_",
  "ghs_",
  "ghr_"
] as const;
const FORCE_KILL_DELAY_MS = 1_000;
const AUTHENTICATION_REQUIRED_MESSAGE =
  "GitHub authentication is required. Run gh auth login and verify your Git/SSH credentials, then try again.";
const NON_INTERACTIVE_ENV = {
  GH_PROMPT_DISABLED: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never"
} as const;
const SENSITIVE_ENV_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN"
] as const;

export type GhRunOptions = {
  timeoutMs?: number;
  /** Receive sanitized stderr chunks while retaining only a bounded tail. */
  onStderr?: (chunk: string) => void;
  env?: Record<string, string | undefined>;
};

export function ghEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":"),
    ...NON_INTERACTIVE_ENV
  };
}

function environmentWith(overrides: GhRunOptions["env"]): NodeJS.ProcessEnv {
  return {
    ...ghEnvironment(),
    ...overrides,
    // A caller may add locale or command-specific values, but no GUI gh call
    // may opt back into a prompt that can open the inherited controlling TTY.
    ...NON_INTERACTIVE_ENV
  };
}

export type GhCliErrorCode =
  | "authentication_required"
  | "timed_out"
  | "output_too_large"
  | "command_failed";

export class GhCliError extends Error {
  readonly name = "GhCliError";

  constructor(
    message: string,
    readonly code: GhCliErrorCode,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

function secretValues(environment: NodeJS.ProcessEnv): string[] {
  return SENSITIVE_ENV_NAMES.map((name) => environment[name]?.trim())
    .filter((value): value is string => value !== undefined && value.length >= 4)
    .sort((a, b) => b.length - a.length);
}

/** Keep CLI diagnostics useful without allowing credentials into UI errors. */
export function sanitizeGhDiagnostic(
  diagnostic: string,
  environment: NodeJS.ProcessEnv = ghEnvironment()
): string {
  let sanitized = diagnostic;
  for (const secret of secretValues(environment)) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized
    .replace(
      /\b((?:GH|GITHUB)(?:_ENTERPRISE)?_TOKEN\s*[=:]\s*)\S+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(authorization\s*:\s*(?:bearer|token)\s+)\S+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(?:gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,
      "[REDACTED]"
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function authenticationRequired(diagnostic: string): boolean {
  return /(?:authentication (?:is )?required|authentication failed|bad credentials|not logged (?:in|into)|gh auth login|http 401|status code 401|terminal prompts disabled|could not read (?:username|password)|no credentials (?:found|available)|permission denied \(publickey\))/i.test(
    diagnostic
  );
}

export function isGhAuthenticationError(cause: unknown): boolean {
  if (cause instanceof GhCliError) {
    return cause.code === "authentication_required";
  }
  if (!(cause instanceof Error)) return false;
  const failure = cause as Error & { stdout?: string; stderr?: string };
  return authenticationRequired(
    `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
  );
}

export function ghErrorMessage(cause: unknown): string {
  if (isGhAuthenticationError(cause)) return AUTHENTICATION_REQUIRED_MESSAGE;
  if (!(cause instanceof Error)) return sanitizeGhDiagnostic(String(cause));
  const failure = cause as Error & { stderr?: string };
  return sanitizeGhDiagnostic(failure.stderr?.trim() || cause.message);
}

function ghFailure(
  cause: unknown,
  stdout: string,
  stderr: string,
  environment: NodeJS.ProcessEnv,
  timedOutMessage?: string
): GhCliError {
  const safeStdout = sanitizeGhDiagnostic(stdout, environment);
  const safeStderr = sanitizeGhDiagnostic(stderr, environment);
  const causeMessage =
    cause instanceof Error ? sanitizeGhDiagnostic(cause.message, environment) : "";
  const diagnostic = `${causeMessage}\n${safeStdout}\n${safeStderr}`;
  if (timedOutMessage !== undefined) {
    return new GhCliError(
      timedOutMessage,
      "timed_out",
      safeStdout,
      safeStderr
    );
  }
  if (authenticationRequired(diagnostic)) {
    return new GhCliError(
      AUTHENTICATION_REQUIRED_MESSAGE,
      "authentication_required",
      safeStdout,
      safeStderr
    );
  }
  return new GhCliError(
    safeStderr.trim() || causeMessage || "GitHub CLI command failed.",
    "command_failed",
    safeStdout,
    safeStderr
  );
}

function appendTail(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return combined.length <= limit
    ? combined
    : combined.slice(-limit);
}

function appendWithinByteLimit(
  current: string,
  chunk: string,
  limit: number
): string {
  const remaining = limit - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  const bytes = Buffer.from(chunk);
  return current + bytes.subarray(0, remaining).toString("utf8");
}

function protectTokenBoundary(diagnostic: string, proposedCut: number): number {
  const windowStart = Math.max(
    0,
    proposedCut - TOKEN_BOUNDARY_LOOKBEHIND_CHARS
  );
  const beforeCut = diagnostic.slice(windowStart, proposedCut);
  let protectedCut = proposedCut;
  for (const prefix of GITHUB_TOKEN_PREFIXES) {
    const tokenStart = beforeCut.lastIndexOf(prefix);
    if (
      tokenStart >= 0 &&
      /^[A-Za-z0-9_]*$/.test(beforeCut.slice(tokenStart + prefix.length))
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
}

function outputTooLargeFailure(
  stream: "stdout" | "stderr",
  stdout: string,
  stderr: string,
  environment: NodeJS.ProcessEnv
): GhCliError {
  return new GhCliError(
    `GitHub CLI ${stream} exceeded the ${MAX_BUFFER_BYTES}-byte limit.`,
    "output_too_large",
    sanitizeGhDiagnostic(stdout, environment),
    sanitizeGhDiagnostic(stderr, environment)
  );
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  // Detached POSIX children own a process group, so kill gh and Git/SSH helpers
  // together. This also prevents an inherited Terminal from becoming their TTY.
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may have already exited; fall through to the child handle.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A close/error event, or the force-kill timer, will settle the operation.
  }
}

function runSpawnedGh(
  args: string[],
  options: GhRunOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const environment = environmentWith(options.env);
    const child = spawn("gh", args, {
      env: environment,
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
    let settled = false;
    let terminationReason:
      | { kind: "timed_out" }
      | { kind: "output_too_large"; stream: "stdout" | "stderr" }
      | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutLimit =
      options.onStderr === undefined ? MAX_BUFFER_BYTES : MAX_STREAM_TAIL_CHARS;
    const stderrLimit =
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
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
      reject(cause);
    };

    const terminationFailure = (): GhCliError => {
      if (terminationReason?.kind === "output_too_large") {
        return outputTooLargeFailure(
          terminationReason.stream,
          stdoutTail,
          stderrTail,
          environment
        );
      }
      return ghFailure(
        new Error("GitHub CLI did not exit before its timeout."),
        stdoutTail,
        stderrTail,
        environment,
        `gh timed out after ${timeoutMs}ms`
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

    const flushStreamingStderr = (complete = true): void => {
      if (options.onStderr === undefined || pendingStreamStderr === "") return;
      let emitLength = pendingStreamStderr.length;
      if (!complete) {
        emitLength = Math.max(
          pendingStreamStderr.lastIndexOf("\n"),
          pendingStreamStderr.lastIndexOf("\r")
        ) + 1;
        if (
          emitLength === 0 &&
          pendingStreamStderr.length > MAX_PENDING_STREAM_STDERR_CHARS
        ) {
          const longestSecret = secretValues(environment).reduce(
            (longest, secret) => Math.max(longest, secret.length),
            0
          );
          const overlap = Math.min(
            MAX_PENDING_STREAM_STDERR_CHARS / 2,
            Math.max(
              MIN_STREAM_REDACTION_OVERLAP_CHARS,
              longestSecret + 64
            )
          );
          emitLength = pendingStreamStderr.length - overlap;
          emitLength = protectTokenBoundary(pendingStreamStderr, emitLength);
          for (const secret of secretValues(environment)) {
            const start = pendingStreamStderr.lastIndexOf(
              secret,
              emitLength - 1
            );
            if (
              start >= 0 &&
              start < emitLength &&
              start + secret.length > emitLength
            ) {
              emitLength = start;
            }
          }
        }
      }
      if (emitLength === 0) return;
      const diagnostic = pendingStreamStderr.slice(0, emitLength);
      pendingStreamStderr = pendingStreamStderr.slice(emitLength);
      options.onStderr(sanitizeGhDiagnostic(diagnostic, environment));
      if (
        !complete &&
        pendingStreamStderr.length > MAX_PENDING_STREAM_STDERR_CHARS
      ) {
        flushStreamingStderr(false);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      // Successful stdout is the API result. In particular, `gh auth token`
      // intentionally returns a credential to the in-process token client.
      // It is sanitized only if the command fails and becomes diagnostic data.
      const text = chunk.toString();
      if (options.onStderr === undefined) {
        stdoutBytes += Buffer.byteLength(text);
        stdoutTail = appendWithinByteLimit(stdoutTail, text, stdoutLimit);
        if (stdoutBytes > stdoutLimit) {
          beginTermination({ kind: "output_too_large", stream: "stdout" });
        }
      } else {
        stdoutTail = appendTail(stdoutTail, text, stdoutLimit);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (options.onStderr === undefined) {
        stderrBytes += Buffer.byteLength(text);
        stderrTail = appendWithinByteLimit(stderrTail, text, stderrLimit);
        if (stderrBytes > stderrLimit) {
          beginTermination({ kind: "output_too_large", stream: "stderr" });
        }
      } else {
        stderrTail = appendTail(stderrTail, text, stderrLimit);
        pendingStreamStderr += text;
        flushStreamingStderr(false);
      }
    });
    child.once("error", (error) => {
      flushStreamingStderr();
      rejectOnce(
        terminationReason === undefined
          ? ghFailure(error, stdoutTail, stderrTail, environment)
          : terminationFailure()
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      flushStreamingStderr();
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
      if (exitCode === 0 && terminationReason === undefined) {
        resolve(stdoutTail.trim());
        return;
      }
      if (terminationReason !== undefined) {
        reject(terminationFailure());
        return;
      }
      const cause = new Error(
        stderrTail.trim() ||
          `gh exited ${exitCode ?? `after signal ${signal ?? "unknown"}`}`
      );
      reject(
        ghFailure(
          cause,
          stdoutTail,
          stderrTail,
          environment
        )
      );
    });
  });
}

/** Run the configured GitHub CLI without exposing its credential storage. */
export async function runGh(
  args: string[],
  options: GhRunOptions = {}
): Promise<string> {
  return runSpawnedGh(args, options);
}
