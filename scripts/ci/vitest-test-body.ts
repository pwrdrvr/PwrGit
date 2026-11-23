import type { TestContext } from "vitest";

export const retryTestBodyStarted = "pwrgitRetryTestBodyStarted";

// Call from the test callback, after Vitest resolves its fixtures. The signal
// prevents a fixture that yields after timeout from marking the test body.
export function markRetryableTestBody(task: TestContext["task"]): void {
  if (!task.context.signal.aborted) Object.assign(task.meta, { [retryTestBodyStarted]: true });
}
