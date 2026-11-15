import type { ChildProcess, ExecFileOptions } from "node:child_process";

/** A cancellable POSIX Git owns a process group, including SSH/filter helpers. */
export function gitProcessGroupOptions(signal: AbortSignal | undefined): { detached?: boolean } {
  return signal !== undefined && process.platform !== "win32" ? { detached: true } : {};
}

/** Node's AbortSignal only kills the direct child, and does nothing once that
 * child exited. A descendant may still own the pipes in either case. */
export function bindGitAbort(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  killSignal: ExecFileOptions["killSignal"],
  onAbort: (terminationError?: unknown) => void
): () => void {
  if (signal === undefined) return () => {};
  const abort = (): void => {
    let terminationError: unknown;
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, killSignal ?? "SIGTERM");
      } else {
        child.kill(killSignal ?? "SIGTERM");
      }
    } catch (cause) {
      // ESRCH means the process group has already gone. Other failures remain
      // evidence, and still attempt direct-child termination.
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {
        terminationError = cause;
        try { child.kill(killSignal ?? "SIGTERM"); } catch { /* Report the first failure. */ }
      }
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    onAbort(terminationError);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}
