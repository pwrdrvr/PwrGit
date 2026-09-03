/**
 * Await every shutdown task, but never hold Electron open past the fail-safe.
 * Tasks are started independently so one synchronous failure cannot prevent
 * another subsystem from beginning its cleanup.
 */
export async function drainBeforeQuit(
  tasks: readonly (() => Promise<unknown>)[],
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  const shutdowns = Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(task))
  ).then(() => undefined);

  try {
    await Promise.race([shutdowns, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
