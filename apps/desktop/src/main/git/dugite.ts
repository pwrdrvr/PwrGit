// dugite is CommonJS; default-import + destructure so the strict-ESM main
// bundle loads it (a named `import { exec }` throws at runtime).
import type { ExecFileOptions } from "node:child_process";
import dugite from "dugite";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import { logMain } from "../logs";

const { exec, spawn: spawnGit } = dugite;

export type GitOutput = { stdout: string; stderr: string; exitCode: number };

export type GitRecordOutput = {
  /** Only records accepted by the caller's predicate are retained. */
  records: string[];
  stderr: string;
  exitCode: number;
  /** More matching records existed than the bounded result could retain. */
  truncated: boolean;
};

export type GitRecordExecOptions = {
  /** Maximum matching NUL-delimited records retained in memory. */
  maxRecords: number;
  /** Maximum total characters retained across matching records. */
  maxChars: number;
  /** Ordinary records are discarded as their stream chunks arrive. */
  matches: (record: string) => boolean;
  /** Extra environment variables applied to this Git process. */
  env?: Record<string, string | undefined>;
};

/** Streaming counterpart to GitExec for large NUL-delimited metadata walks. */
export type GitRecordExec = (
  args: string[],
  cwd: string,
  options: GitRecordExecOptions
) => Promise<Result<GitRecordOutput, PwrGitError>>;

export type GitExecOptions = {
  /** Receive stderr as Git writes it (progress output is emitted here). */
  onStderr?: (chunk: string) => void;
  /** Called whenever Git writes stdout or stderr; used by pull watchdogs. */
  onActivity?: () => void;
  /** Extra environment variables applied to this Git process. */
  env?: Record<string, string | undefined>;
  /** Abort the direct Git process through Dugite/Node execFile. */
  signal?: AbortSignal;
  /** Signal used when `signal` aborts. */
  killSignal?: ExecFileOptions["killSignal"];
};

const MAX_LOG_DETAIL_CHARS = 1_200;
const NON_INTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never"
} as const;

/** Preserve per-command overlays while enforcing the GUI's non-interactive
 * invariant even if a caller accidentally attempts to re-enable prompting. */
export function gitExecutionEnvironment(
  overrides: GitExecOptions["env"] = {}
): Record<string, string | undefined> {
  return { ...overrides, ...NON_INTERACTIVE_GIT_ENV };
}

/** Read-only probes should never compete with a mutating Git command's lock. */
export const NO_OPTIONAL_LOCKS = {
  env: { GIT_OPTIONAL_LOCKS: "0" }
} satisfies GitExecOptions;

/** Keep Git diagnostics useful in Logs without retaining common credentials. */
export function sanitizeGitLogDetail(detail: unknown): string {
  const raw =
    typeof detail === "string"
      ? detail
      : detail instanceof Error
        ? detail.message
        : (() => {
            try {
              return JSON.stringify(detail) ?? String(detail);
            } catch {
              return String(detail);
            }
          })();
  const sanitized = raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b(?:gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,})\b/gi,
      "[redacted credential]"
    )
    .replace(
      /([?&](?:access_token|auth|password|token)=)[^&\s]+/gi,
      "$1[redacted]"
    )
    .replace(
      /(?:authorization|proxy-authorization):[^\r\n]*/gi,
      (match) => `${match.slice(0, match.indexOf(":"))}: [redacted]`
    )
    .replace(/[\r\n]+/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length <= MAX_LOG_DETAIL_CHARS
    ? sanitized
    : `…${sanitized.slice(-MAX_LOG_DETAIL_CHARS)}`;
}

function gitCommandLogLabel(args: string[], cwd: string): string {
  return sanitizeGitLogDetail(`git ${args.join(" ")} (${cwd})`);
}

function abortError(signal: AbortSignal): PwrGitError {
  const reason = signal.reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "kind" in reason &&
    "code" in reason &&
    "message" in reason
  ) {
    return reason as PwrGitError;
  }
  return {
    kind: "git",
    code: "aborted",
    message: "Git was stopped before it completed.",
    cause: reason
  };
}

function abortedSignal(options: GitExecOptions | undefined): AbortSignal | null {
  return options?.signal?.aborted === true ? options.signal : null;
}

/**
 * Runs a git command in `cwd` and resolves to the process output. Injected
 * everywhere git is needed so callers stay decoupled from dugite — tests pass
 * a system-git-backed exec instead of dugite's bundled binary.
 *
 * A completed process (any exit code) resolves to `ok`; only a spawn failure
 * resolves to `err`. Callers inspect `exitCode` when non-zero matters.
 */
export type GitExec = (
  args: string[],
  cwd: string,
  options?: GitExecOptions
) => Promise<Result<GitOutput, PwrGitError>>;

/** Production GitExec backed by dugite's bundled git binary (KTD1). */
export const execGit: GitExec = async (args, cwd, options) => {
  const alreadyAborted = abortedSignal(options);
  if (alreadyAborted !== null) return err(abortError(alreadyAborted));
  try {
    const result = await exec(args, cwd, {
      env: gitExecutionEnvironment(options?.env),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.killSignal !== undefined
        ? { killSignal: options.killSignal }
        : {}),
      processCallback: (child) => {
        child.stdout?.on("data", () => options?.onActivity?.());
        child.stderr?.on("data", (chunk: Buffer | string) => {
          options?.onActivity?.();
          options?.onStderr?.(chunk.toString());
        });
      }
    });
    const aborted = abortedSignal(options);
    if (aborted !== null) return err(abortError(aborted));
    // Non-zero exits are logged at debug: many are routine probes (cat-file
    // -e, stash pop with conflicts), but when a command silently fails this
    // is the ground truth the Logs window surfaces.
    if (result.exitCode !== 0) {
      logMain(
        "debug",
        "git",
        `${gitCommandLogLabel(args, cwd)} exited ${result.exitCode}:`,
        sanitizeGitLogDetail(result.stderr)
      );
    }
    return ok({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    });
  } catch (cause) {
    const aborted = abortedSignal(options);
    if (aborted !== null) return err(abortError(aborted));
    logMain(
      "error",
      "git",
      `${gitCommandLogLabel(args, cwd)} failed to spawn:`,
      sanitizeGitLogDetail(cause)
    );
    return err({
      kind: "git",
      code: "spawn_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause
    });
  }
};

const MAX_STREAM_STDERR_CHARS = 32_768;

/**
 * Run a NUL-delimited Git query without allowing its complete stdout to be
 * buffered by Dugite. This is for metadata commands such as ls-tree and
 * ls-files where a million ordinary tracked paths may precede the handful of
 * records the caller needs. Non-matching records are discarded immediately;
 * once either the record or retained-character limit would be exceeded, Git
 * is stopped and the bounded result is marked truncated.
 */
export const execGitRecords: GitRecordExec = (args, cwd, options) =>
  new Promise((resolveResult) => {
    let child: ReturnType<typeof spawnGit>;
    try {
      child = spawnGit(args, cwd, {
        env: gitExecutionEnvironment(options.env)
      });
    } catch (cause) {
      resolveResult(
        err({
          kind: "git",
          code: "spawn_failed",
          message: cause instanceof Error ? cause.message : String(cause),
          cause
        })
      );
      return;
    }

    const records: string[] = [];
    let retainedChars = 0;
    let remainder = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const finish = (result: Result<GitRecordOutput, PwrGitError>): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Once intentionally truncated, keep draining the pipe until the process
      // exits but retain no more bytes if termination is not instantaneous.
      if (truncated) return;
      remainder += chunk;
      if (remainder.length > options.maxChars) {
        truncated = true;
        remainder = "";
        child.kill();
        return;
      }
      let boundary = remainder.indexOf("\0");
      while (boundary >= 0) {
        const record = remainder.slice(0, boundary);
        remainder = remainder.slice(boundary + 1);
        if (record !== "" && options.matches(record)) {
          if (
            records.length >= options.maxRecords ||
            retainedChars + record.length > options.maxChars
          ) {
            truncated = true;
            remainder = "";
            child.kill();
            return;
          }
          records.push(record);
          retainedChars += record.length;
        }
        boundary = remainder.indexOf("\0");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STREAM_STDERR_CHARS);
    });
    child.on("error", (cause) => {
      finish(
        err({
          kind: "git",
          code: "spawn_failed",
          message: cause.message,
          cause
        })
      );
    });
    child.on("close", (exitCode) => {
      finish(
        ok({
          records,
          stderr,
          // A deliberate bound is a successful partial query even though the
          // terminated process can report a platform-specific signal code.
          exitCode: truncated ? 0 : (exitCode ?? 1),
          truncated
        })
      );
    });
  });

export type GitBinaryOutput = {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
};

/**
 * Like `GitExec`, but keeps stdout as raw bytes. Blob contents (image
 * previews) must not go through utf8 decoding — it replaces every byte that
 * isn't valid UTF-8 and silently corrupts the file.
 */
export type GitExecBinary = (
  args: string[],
  cwd: string
) => Promise<Result<GitBinaryOutput, PwrGitError>>;

/** Production GitExecBinary backed by dugite's bundled git binary. */
export const execGitBinary: GitExecBinary = async (args, cwd) => {
  try {
    const result = await exec(args, cwd, {
      encoding: "buffer",
      env: gitExecutionEnvironment(NO_OPTIONAL_LOCKS.env)
    });
    return ok({
      stdout: result.stdout,
      stderr: result.stderr.toString(),
      exitCode: result.exitCode
    });
  } catch (cause) {
    logMain(
      "error",
      "git",
      `${gitCommandLogLabel(args, cwd)} failed to spawn:`,
      sanitizeGitLogDetail(cause)
    );
    return err({
      kind: "git",
      code: "spawn_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause
    });
  }
};

/** Turn a non-zero git exit into a typed error; pass through ok output. */
export function requireExit0(
  output: GitOutput,
  args: string[]
): Result<GitOutput, PwrGitError> {
  if (output.exitCode !== 0) {
    return err({
      kind: "git",
      code: `exit_${output.exitCode}`,
      message:
        output.stderr.trim() !== ""
          ? output.stderr.trim()
          : `git ${args.join(" ")} exited ${output.exitCode}`
    });
  }
  return ok(output);
}
