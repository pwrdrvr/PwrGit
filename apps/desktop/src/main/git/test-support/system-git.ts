import { spawn } from "node:child_process";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import {
  gitExecutionEnvironment,
  gitProcessInvocation,
  settleOnGitExit,
  type GitBinaryOutput,
  type GitExec,
  type GitExecBinary,
  type GitExecOptions,
  type GitOutput
} from "../dugite";

/**
 * The `GitExec` the main-process suites run against real `git`.
 *
 * It exists as one module because twenty-four hand-rolled copies of it each
 * carried the same defect — awaiting `close` rather than `exit` — and a defect
 * with twenty-four homes gets fixed once or not at all. A twenty-fifth copy
 * (`bulk-sync.test.ts`) was built on `execFile` and never had the bug; it
 * routes through here anyway, because a surviving hand-rolled helper is the
 * template the next one gets copied from.
 *
 * `settleOnGitExit` in ../dugite.ts carries that rule, and the reasoning, for
 * this double and for production's `execGitRecords` alike. What this module
 * adds on top is fidelity to the `GitExec` contract: the same environment
 * handling, cancellation, and stderr/activity callbacks production's `execGit`
 * gives its callers, so a suite exercising those paths is testing the real
 * shape rather than a double that quietly ignores half of them.
 */
export type SystemGitOptions = {
  /** Base environment for the child. Defaults to this process's own. */
  env?: NodeJS.ProcessEnv;
};

type Collected = { stdout: Buffer[]; stderr: Buffer[]; exitCode: number };

/** Production's `execGit` reports a cancelled run as this typed error rather
 *  than as a signal-killed exit, and checks the signal on both sides of the
 *  call. A double that resolved `spawn_failed` instead would make a cancelling
 *  test assert against the wrong error. */
function abortError(cause: AbortSignal): PwrGitError {
  return {
    kind: "git",
    code: "aborted",
    message: "Git was stopped before it completed.",
    cause: cause.reason
  };
}

function abortedSignal(options: GitExecOptions | undefined): AbortSignal | null {
  return options?.signal?.aborted === true ? options.signal : null;
}

function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: GitExecOptions
): Promise<Result<Collected, PwrGitError>> {
  return new Promise((resolve) => {
    const invocation = gitProcessInvocation(args, cwd);
    const spawnFailed = (cause: Error): Result<Collected, PwrGitError> =>
      err({ kind: "git", code: "spawn_failed", message: cause.message });

    let proc;
    try {
      proc = spawn("git", invocation.args, {
        cwd: invocation.processCwd,
        env,
        // Nothing here answers a prompt, and an inherited stdin lets a git
        // that decides to read one block until the suite's timeout.
        stdio: ["ignore", "pipe", "pipe"],
        // Cancellation is part of the GitExec contract: production's execGit
        // honours it, so a test double that quietly ignored it would let an
        // un-aborted git run to the suite timeout — the very failure this
        // module exists to remove.
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.killSignal === undefined
          ? {}
          : { killSignal: options.killSignal })
      });
    } catch (cause) {
      // spawn throws synchronously on bad options; dugite.ts guards its own
      // spawn the same way rather than rejecting out of a Result-returning API.
      resolve(spawnFailed(cause instanceof Error ? cause : new Error(String(cause))));
      return;
    }
    const child = proc;

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const settle = (result: Result<Collected, PwrGitError>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // `settleOnGitExit` owns the exit-not-close rule and the pipe teardown;
    // see its comment in ../dugite.ts for why `close` is the wrong event.
    const release = settleOnGitExit(child, (code) => {
      // A null code means a signal killed the child — a failure, not a silent
      // success, and reachable because `signal` is honoured above.
      settle(ok({ stdout, stderr, exitCode: code ?? 1 }));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      options?.onActivity?.();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      options?.onActivity?.();
      if (options?.onStderr) options.onStderr(chunk.toString());
    });

    child.on("error", (cause) => {
      release();
      settle(spawnFailed(cause));
    });
  });
}

/**
 * Merge the caller's environment the way production does, so a suite cannot
 * accidentally re-enable prompting: `gitExecutionEnvironment` forces the
 * non-interactive invariant over whatever it is handed.
 */
function execEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: GitExecOptions["env"]
): NodeJS.ProcessEnv {
  return gitExecutionEnvironment({ ...base, ...overrides });
}

/** Text-mode `GitExec`; per-call `options.env` overlays the base environment. */
export function createSystemGit(base: SystemGitOptions = {}): GitExec {
  const baseEnv = base.env ?? process.env;
  return async (args, cwd, options) => {
    const alreadyAborted = abortedSignal(options);
    if (alreadyAborted !== null) return err(abortError(alreadyAborted));
    const run = await runGit(
      args,
      cwd,
      execEnvironment(baseEnv, options?.env),
      options
    );
    const aborted = abortedSignal(options);
    if (aborted !== null) return err(abortError(aborted));
    if (!run.ok) return run;
    return ok({
      stdout: Buffer.concat(run.value.stdout).toString(),
      // Decoded once, whole: a multi-byte sequence split across two chunks
      // decodes to replacement characters if each chunk is stringified alone.
      stderr: Buffer.concat(run.value.stderr).toString(),
      exitCode: run.value.exitCode
    } satisfies GitOutput);
  };
}

/** Byte-exact `GitExecBinary` — a utf8 round-trip would corrupt image blobs. */
export function createSystemGitBinary(
  base: SystemGitOptions = {}
): GitExecBinary {
  const baseEnv = base.env ?? process.env;
  return async (args, cwd) => {
    const run = await runGit(args, cwd, execEnvironment(baseEnv, undefined));
    if (!run.ok) return run;
    return ok({
      stdout: Buffer.concat(run.value.stdout),
      stderr: Buffer.concat(run.value.stderr).toString(),
      exitCode: run.value.exitCode
    } satisfies GitBinaryOutput);
  };
}
