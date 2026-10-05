import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { beginGitCall } from "./git-tripwire";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import {
  gitExecutionEnvironment,
  gitProcessInvocation,
  installedGitEnvironment,
  type GitBinaryOutput,
  type GitExec,
  type GitExecBinary,
  type GitExecOptions,
  type GitLaunch,
  type GitOutput
} from "../dugite";

/** Shared fixture executor. Preserve the existing exit + stream-end policy
 * and 250ms post-exit grace. Grace expiry does not identify a pipe owner or
 * establish the cause of a test timeout; diagnostics record it before cleanup. */
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
  launch: GitLaunch,
  options?: GitExecOptions
): Promise<Result<Collected, PwrGitError>> {
  return new Promise((resolve) => {
    let snapshot: () => Record<string, unknown> = () => ({});
    const call = beginGitCall(args, cwd, "async", () => snapshot());
    const invocation = gitProcessInvocation(args, cwd);
    const spawnFailed = (cause: Error): Result<Collected, PwrGitError> =>
      err({ kind: "git", code: "spawn_failed", message: cause.message });

    let proc;
    try {
      proc = spawn(launch.binary, invocation.args, {
        cwd: invocation.processCwd,
        env: launch.env,
        // Nothing here answers a prompt, and an inherited stdin lets a git
        // that decides to read one block until the suite's timeout. A pipe
        // closed at once reads as EOF, and carries `input` when there is one.
        stdio: ["pipe", "pipe", "pipe"],
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
      call?.event("spawn-throw");
      call?.finish("spawn-failed");
      resolve(spawnFailed(cause instanceof Error ? cause : new Error(String(cause))));
      return;
    }
    const child = proc;
    // Git can close stdin before the write lands; its exit code says why.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options?.input);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let openStreams = 2;
    let exited = false;
    // A null code means a signal killed the child. That is a failure, not a
    // silent success — and it is reachable now that `signal` is honoured.
    let exitCode = 1;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const streamState = (stream: typeof child.stdout) => ({ ended: stream.readableEnded,
      destroyed: stream.destroyed, closed: stream.closed, bufferedBytes: stream.readableLength });
    snapshot = () => ({ pid: child.pid, exitObserved: exited, exitCode: child.exitCode,
      signalCode: child.signalCode, killed: child.killed,
      stdout: streamState(child.stdout), stderr: streamState(child.stderr),
      stdoutBytes: stdout.reduce((n, chunk) => n + chunk.length, 0),
      stderrBytes: stderr.reduce((n, chunk) => n + chunk.length, 0) });
    const onSpawn = () => call?.event("spawn");
    if (call) child.once("spawn", onSpawn);

    const settle = (result: Result<Collected, PwrGitError>): void => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      child.removeListener("spawn", onSpawn);
      call?.event("settlement");
      call?.finish(result.ok ? "resolved" : "error-result");
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
      call?.event("stdout-end");
      openStreams -= 1;
      finishWhenDrained();
    });
    child.stderr.once("end", () => {
      call?.event("stderr-end");
      openStreams -= 1;
      finishWhenDrained();
    });

    child.on("error", (cause) => { call?.event("child-error"); settle(spawnFailed(cause)); });
    child.on("exit", (code) => {
      exited = true;
      call?.event("exit");
      if (code !== null) exitCode = code;
      grace = setTimeout(() => { call?.report("drain-grace-expired"); finish(); }, FLUSH_GRACE_MS);
      grace.unref?.();
      finishWhenDrained();
    });
  });
}

/**
 * Which Git the code under test runs. Fixture helpers that call
 * `execFileSync("git")` always run the first `git` on PATH; this only decides
 * the Git behind `createSystemGit` and `createSystemGitBinary`.
 *
 * - `bundled`, the default: Dugite's bundle, which is what PwrGit runs unless
 *   Settings › Git runtime names another Git. The lockfile pins it, so a
 *   runner image or a developer's Homebrew upgrade cannot change the result.
 * - `installed`: the first `git` on PATH, launched the way production
 *   launches a Git chosen in Settings. Its environment comes from
 *   `installedGitEnvironment`, so none of the bundle's variables reach it.
 *
 * Select it with `PWRGIT_TEST_GIT`. CI runs only the default.
 */
export type SystemGitRuntime = "bundled" | "installed";

/** An unknown value throws: a typo must not quietly test the bundle. */
export function systemGitRuntime(env: NodeJS.ProcessEnv = process.env): SystemGitRuntime {
  const value = env.PWRGIT_TEST_GIT;
  if (value === undefined || value === "" || value === "bundled") return "bundled";
  if (value === "installed") return "installed";
  throw new Error(`PWRGIT_TEST_GIT must be "bundled" or "installed", not "${value}".`);
}

/** The `git` a shell would run with `env`'s PATH. */
function gitOnPath(env: NodeJS.ProcessEnv): string {
  const name = process.platform === "win32" ? "git.exe" : "git";
  // Windows names it `Path`; Node's own lookup ignores the case there too.
  const path = Object.entries(env).find(([key]) =>
    process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH"
  )?.[1] ?? "";
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here. A shell would keep looking, so this does too.
    }
  }
  throw new Error(`PWRGIT_TEST_GIT=installed found no ${name} on PATH.`);
}

/**
 * Production's launch for `runtime`: the binary to spawn, and each call's
 * environment with its `options.env` merged over `base`. Both environments
 * force the non-interactive invariant over whatever they are handed, so a
 * suite cannot re-enable prompting (#261).
 */
export function systemGitLauncher(
  base: NodeJS.ProcessEnv,
  runtime: SystemGitRuntime = systemGitRuntime()
): (overrides: GitExecOptions["env"]) => GitLaunch {
  if (runtime === "bundled") {
    // `gitExecutionEnvironment` puts the bundle first on PATH, so a bare
    // `git` finds it.
    return (overrides) => ({
      binary: "git",
      env: gitExecutionEnvironment({ ...base, ...overrides })
    });
  }
  const binary = gitOnPath(base);
  return (overrides) => ({
    binary,
    env: installedGitEnvironment({ ...base, ...overrides }, binary)
  });
}

/** Text-mode `GitExec`; per-call `options.env` overlays the base environment. */
export function createSystemGit(base: SystemGitOptions = {}): GitExec {
  const launch = systemGitLauncher(base.env ?? process.env);
  return async (args, cwd, options) => {
    const alreadyAborted = abortedSignal(options);
    if (alreadyAborted !== null) return err(abortError(alreadyAborted));
    const run = await runGit(args, cwd, launch(options?.env), options);
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
  const launch = systemGitLauncher(base.env ?? process.env);
  return async (args, cwd) => {
    const run = await runGit(args, cwd, launch(undefined));
    if (!run.ok) return run;
    return ok({
      stdout: Buffer.concat(run.value.stdout),
      stderr: Buffer.concat(run.value.stderr).toString(),
      exitCode: run.value.exitCode
    } satisfies GitBinaryOutput);
  };
}
