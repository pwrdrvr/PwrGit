// dugite is CommonJS; default-import it so the strict-ESM main bundle loads
// it (a named `import { exec }` throws at runtime).
import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileOptions } from "node:child_process";
import { bundledGitEnvironment, installedKeychainHelper } from "@pwrgit/mcp-server";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import dugite from "dugite";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import { cliSearchPath } from "../forge/cli-runner";
import { logMain } from "../logs";

let bundledDirectory = dugite.resolveEmbeddedGitDir();
let generatedConfigDirectory: string | null = null;
let installedGit: string | null = null;

/** Set once at startup: packaged Git lives outside the asar. */
export function configureBundledGit(directory: string): void {
  bundledDirectory = directory;
}

/**
 * Set once at startup: where the system config PwrGit writes for the bundle
 * lives. Until it is set the bundle runs with Dugite's own config — no LFS
 * filter and no keychain helper — which is what keeps unit tests from writing
 * into the real app data directory.
 */
export function configureBundledGitConfig(directory: string | null): void {
  generatedConfigDirectory = directory;
}

/**
 * The installed Git chosen in Settings, or null for the bundle. Never checked
 * here: a choice that has since broken fails every command loudly instead of
 * quietly running a different Git than the one Settings names.
 */
export function useInstalledGit(path: string | null): void {
  installedGit = path;
}

export function installedGitSelection(): string | null {
  return installedGit;
}

export function bundledGitPath(): string {
  return dugite.resolveGitBinary(bundledDirectory);
}

/** What `git` the app runs right now. */
export function activeGitPath(): string {
  return installedGit ?? bundledGitPath();
}

/** Directories launchd hands an app opened from Finder or the Dock. */
const LAUNCHD_PATH = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/**
 * The PATH walked to the installed Git whose keychain helper the bundle
 * borrows. A keychain item stays readable without a prompt only by the helper
 * that stored it, which is the one the user's terminal Git runs. An app opened
 * from Finder inherits launchd's PATH, where Apple's /usr/bin/git comes before
 * Homebrew's — the reverse of a shell that ran `brew shellenv` — so Homebrew's
 * directories are tried before launchd's, and everything else keeps its order.
 */
function keychainSearchPath(): string {
  const entries = [...new Set(cliSearchPath().split(delimiter).filter(Boolean))];
  const own = entries.filter((entry) => !LAUNCHD_PATH.has(entry));
  const system = entries.filter((entry) => LAUNCHD_PATH.has(entry));
  return [...own, ...system].join(delimiter);
}

/** The installed `git-credential-osxkeychain` the bundle runs, if any. */
export function bundledKeychainHelper(): string | null {
  if (process.platform !== "darwin") return null;
  return installedKeychainHelper({ PATH: keychainSearchPath(), DEVELOPER_DIR: process.env.DEVELOPER_DIR }) ?? null;
}

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

export type GitProcessInvocation = {
  args: string[];
  processCwd: string;
};

/**
 * Keep the native Git process out of a worktree that PwrGit may delete.
 *
 * Git-for-Windows' `cmd\\git.exe` can hand execution to another process. If
 * the launcher inherits the worktree as its native cwd, Dugite can report the
 * immediate child complete while the handed-off process still prevents
 * `git worktree remove` from deleting that directory. `git -C` preserves Git's
 * repository-relative behavior while every launcher starts from the stable OS
 * temp root instead.
 */
export function gitProcessInvocation(
  args: string[],
  cwd: string
): GitProcessInvocation {
  return {
    args: ["-C", cwd, ...args],
    processCwd: tmpdir()
  };
}

/** Preserve per-command overlays while enforcing the GUI's non-interactive
 * invariant even if a caller accidentally attempts to re-enable prompting. */
export function gitExecutionEnvironment(
  overrides: GitExecOptions["env"] = {}
): Record<string, string | undefined> {
  return {
    ...bundledGitEnvironment(bundledDirectory, overrides, {
      configDirectory: generatedConfigDirectory,
      searchPath: keychainSearchPath()
    }),
    ...NON_INTERACTIVE_GIT_ENV
  };
}

const within = (directory: string, value: string): boolean => {
  const path = relative(directory, value);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/**
 * An environment for an installed Git: nothing of the bundle's. Each bundle
 * variable would redirect it — `GIT_EXEC_PATH` to the bundle's helpers, the
 * generated `GIT_CONFIG_SYSTEM` in place of the installed Git's own, and the
 * bundle's directories on PATH ahead of its `git-lfs`. The installed Git's
 * own directory goes first, then the CLI search path, because an app opened
 * from Finder has no Homebrew on PATH for that Git's hooks and LFS to find.
 */
export function installedGitEnvironment(
  source: NodeJS.ProcessEnv,
  command: string
): NodeJS.ProcessEnv {
  const env = { ...source };
  const bundle = resolve(bundledDirectory);
  const inBundle = (value: string): boolean => within(bundle, value);
  let inheritedPath = "";
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    const value = env[key];
    if (upper === "PATH") {
      inheritedPath = value ?? "";
      delete env[key];
    } else if (
      ["LOCAL_GIT_DIRECTORY", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR"].includes(upper) ||
      (["GIT_CONFIG_SYSTEM", "PREFIX", "GIT_SSL_CAINFO"].includes(upper) &&
        value !== undefined &&
        inBundle(value)) ||
      (upper === "GIT_CONFIG_SYSTEM" &&
        value !== undefined &&
        generatedConfigDirectory !== null &&
        within(resolve(generatedConfigDirectory), value))
    ) {
      delete env[key];
    }
  }
  const searchPath = process.platform === "win32" ? inheritedPath : [inheritedPath, cliSearchPath()].join(delimiter);
  env.PATH = [
    ...new Set([
      dirname(command),
      ...searchPath.split(delimiter).filter((entry) => entry !== "" && !inBundle(entry))
    ])
  ].join(delimiter);
  return { ...env, ...NON_INTERACTIVE_GIT_ENV };
}

export type GitLaunch = { binary: string; env: NodeJS.ProcessEnv };

/**
 * The executable and complete environment for one Git process: the installed
 * Git chosen in Settings, or the bundle. `installed` names a runtime other
 * than the one in use — Settings probes every candidate this way.
 */
export function gitLaunch(
  overrides: GitExecOptions["env"] = {},
  installed: string | null = installedGit
): GitLaunch {
  if (installed !== null) {
    return { binary: installed, env: installedGitEnvironment({ ...process.env, ...overrides }, installed) };
  }
  // What `dugite.exec` does with the same overlay: process.env beneath it,
  // then the bundle's own GIT_EXEC_PATH, templates and (unset) system config.
  const { env, gitLocation } = dugite.setupEnvironment(gitExecutionEnvironment(overrides));
  return { binary: gitLocation, env };
}

/** Name the Git that failed to start; for an installed one, say where it was chosen. */
function spawnFailureMessage(binary: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { code?: unknown } | null)?.code;
  if (binary === installedGit) {
    return `The Git selected in Settings could not run (${binary}): ${message}. Choose another Git, or the bundled one, in Settings › General › Git runtime.`;
  }
  return code === "ENOENT"
    ? `PwrGit's bundled Git could not run (${binary}). Reinstalling PwrGit restores it.`
    : message;
}

type ExecFileResult<T> = { stdout: T; stderr: T; exitCode: number };

/** `dugite.exec`'s contract for any Git: a non-zero exit resolves; only a
 *  failure to start (a string error code, such as ENOENT) rejects. */
function execFileGit(
  launch: GitLaunch,
  args: string[],
  cwd: string,
  options: {
    encoding: "utf8" | "buffer";
    signal?: AbortSignal;
    killSignal?: ExecFileOptions["killSignal"];
    processCallback?: (child: ReturnType<typeof execFile>) => void;
  }
): Promise<ExecFileResult<string | Buffer>> {
  return new Promise((resolveExec, rejectExec) => {
    const child = execFile(
      launch.binary,
      args,
      {
        cwd,
        env: launch.env,
        encoding: options.encoding,
        maxBuffer: Infinity,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.killSignal === undefined ? {} : { killSignal: options.killSignal })
      },
      (error, stdout, stderr) => {
        if (error === null || typeof error.code === "number") {
          resolveExec({
            stdout,
            stderr,
            exitCode: typeof error?.code === "number" ? error.code : 0
          });
          return;
        }
        rejectExec(new Error(spawnFailureMessage(launch.binary, error), { cause: error }));
      }
    );
    // Git can close stdin before a write lands; the exit code says what happened.
    child.stdin?.on("error", () => undefined);
    options.processCallback?.(child);
  });
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

/** Production GitExec: dugite's bundled git binary (KTD1), or the installed
 *  Git chosen in Settings. */
export const execGit: GitExec = async (args, cwd, options) => {
  const alreadyAborted = abortedSignal(options);
  if (alreadyAborted !== null) return err(abortError(alreadyAborted));
  try {
    const invocation = gitProcessInvocation(args, cwd);
    const result = await execFileGit(gitLaunch(options?.env), invocation.args, invocation.processCwd, {
      encoding: "utf8",
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
      stdout: String(result.stdout),
      stderr: String(result.stderr),
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
    let child: ChildProcessWithoutNullStreams;
    const launch = gitLaunch(options.env);
    try {
      const invocation = gitProcessInvocation(args, cwd);
      child = spawn(launch.binary, invocation.args, {
        cwd: invocation.processCwd,
        env: launch.env
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
          message: spawnFailureMessage(launch.binary, cause),
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

/** Production GitExecBinary: the same runtime as `execGit`. */
export const execGitBinary: GitExecBinary = async (args, cwd) => {
  try {
    const invocation = gitProcessInvocation(args, cwd);
    const result = await execFileGit(gitLaunch(NO_OPTIONAL_LOCKS.env), invocation.args, invocation.processCwd, {
      encoding: "buffer"
    });
    return ok({
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout),
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
