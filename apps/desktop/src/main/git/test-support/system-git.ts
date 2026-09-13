import { spawn } from "node:child_process";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import {
  gitProcessInvocation,
  type GitBinaryOutput,
  type GitExec,
  type GitExecBinary,
  type GitOutput
} from "../dugite";

/**
 * The `GitExec` the main-process suites run against real `git`.
 *
 * It exists as one module because the hand-rolled copies it replaces all
 * shared a defect, and twenty-two copies of a defect get fixed once here.
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

type Collected = { stdout: Buffer[]; stderr: string; exitCode: number };

function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<Result<Collected, PwrGitError>> {
  return new Promise((resolve) => {
    const invocation = gitProcessInvocation(args, cwd);
    const proc = spawn("git", invocation.args, {
      cwd: invocation.processCwd,
      env,
      // Nothing here answers a prompt, and an inherited stdin lets a git that
      // decides to read one block until the suite's timeout.
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    let stderr = "";
    let openStreams = 2;
    let exited = false;
    let exitCode = 0;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: Result<Collected, PwrGitError>): void => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      resolve(result);
    };
    const finish = (): void => settle(ok({ stdout, stderr, exitCode }));
    const finishWhenDrained = (): void => {
      if (exited && openStreams === 0) finish();
    };

    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.stdout.once("end", () => {
      openStreams -= 1;
      finishWhenDrained();
    });
    proc.stderr.once("end", () => {
      openStreams -= 1;
      finishWhenDrained();
    });

    proc.on("error", (cause) =>
      settle(err({ kind: "git", code: "spawn_failed", message: cause.message }))
    );
    proc.on("exit", (code) => {
      exited = true;
      exitCode = code ?? 0;
      grace = setTimeout(finish, FLUSH_GRACE_MS);
      grace.unref?.();
      finishWhenDrained();
    });
  });
}

/** Text-mode `GitExec`; per-call `options.env` overlays the base environment. */
export function createSystemGit(base: SystemGitOptions = {}): GitExec {
  const baseEnv = base.env ?? process.env;
  return async (args, cwd, options) => {
    const run = await runGit(args, cwd, { ...baseEnv, ...options?.env });
    if (!run.ok) return run;
    return ok({
      stdout: Buffer.concat(run.value.stdout).toString(),
      stderr: run.value.stderr,
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
    const run = await runGit(args, cwd, baseEnv);
    if (!run.ok) return run;
    return ok({
      stdout: Buffer.concat(run.value.stdout),
      stderr: run.value.stderr,
      exitCode: run.value.exitCode
    } satisfies GitBinaryOutput);
  };
}
