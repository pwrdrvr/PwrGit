import { spawn } from "node:child_process";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import {
  gitExecutionEnvironment,
  gitProcessInvocation,
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
 * carried the same defect, and a defect with twenty-four homes gets fixed once
 * or not at all. A twenty-fifth copy (`bulk-sync.test.ts`) was built on
 * `execFile` and never had the bug; it routes through here anyway, because a
 * surviving hand-rolled helper is the template the next one gets copied from.
 *
 * **Settle on `exit`, never on `close`.** `close` fires only after every
 * process holding the child's inherited stdio pipes has let go of them, which
 * is not the same question as "did git finish". Git-for-Windows' `cmd\git.exe`
 * hands execution to another process — ../dugite.ts documents the same
 * behavior biting `git worktree remove` — and a handed-off grandchild keeps
 * those pipes open after git itself has exited. A helper awaiting `close`
 * therefore waits out the stranger, not the command: a millisecond-scale git
 * call becomes a multi-second hang, and the test dies on the Vitest timeout
 * having never learned what git did. That is bimodal by nature — the handoff
 * either lingers or it doesn't — which is why it read as a flake, and why
 * raising the timeout only bought the hang more room.
 *
 * So we resolve once git has exited *and* its own streams have ended, and
 * never wait more than FLUSH_GRACE_MS past exit for a stream some grandchild
 * is holding open. The child's own output has already been delivered by then;
 * a 300KB stdout survives the grace path intact.
 */
const FLUSH_GRACE_MS = 250;

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
    let openStreams = 2;
    let exited = false;
    // A null code means a signal killed the child. That is a failure, not a
    // silent success — and it is reachable now that `signal` is honoured.
    let exitCode = 1;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: Result<Collected, PwrGitError>): void => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      // A grandchild can hold these pipes open long after we have answered.
      // Left attached, they keep appending to buffers nobody will read and
      // keep the child and its streams alive for the stranger's lifetime.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(result);
    };
    const finish = (): void => settle(ok({ stdout, stderr, exitCode }));
    const finishWhenDrained = (): void => {
      if (exited && openStreams === 0) finish();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      options?.onActivity?.();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      options?.onActivity?.();
      if (options?.onStderr) options.onStderr(chunk.toString());
    });
    child.stdout.once("end", () => {
      openStreams -= 1;
      finishWhenDrained();
    });
    child.stderr.once("end", () => {
      openStreams -= 1;
      finishWhenDrained();
    });

    child.on("error", (cause) => settle(spawnFailed(cause)));
    child.on("exit", (code) => {
      exited = true;
      if (code !== null) exitCode = code;
      grace = setTimeout(finish, FLUSH_GRACE_MS);
      grace.unref?.();
      finishWhenDrained();
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
