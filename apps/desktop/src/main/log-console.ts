import electronLog from "electron-log/main.js";

let stopConsoleLogging: (() => void) | undefined;

function isClosedPipe(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}

/** Enable console logging with the Pwr siblings' closed-stdio protection. */
export function initLogConsole(): () => void {
  if (stopConsoleLogging) return stopConsoleLogging;

  const transport = electronLog.transports.console;
  transport.level = process.env.VITEST === "true" ? false : "info";

  const originalWrite = transport.writeFn;
  const onError = (error: unknown): void => {
    if (isClosedPipe(error)) {
      transport.level = false;
    } else {
      queueMicrotask(() => { throw error; });
    }
  };
  // A dev terminal can disappear while the app remains alive. Preserve file
  // logging and the Logs window when either a sync write or async stream fails.
  transport.writeFn = (options) => {
    if (transport.level === false) return;
    try {
      originalWrite.call(transport, options);
    } catch (error) {
      if (!isClosedPipe(error)) throw error;
      transport.level = false;
    }
  };
  process.stdout.on("error", onError);
  process.stderr.on("error", onError);
  stopConsoleLogging = () => {
    process.stdout.off("error", onError);
    process.stderr.off("error", onError);
    transport.writeFn = originalWrite;
    transport.level = false;
    stopConsoleLogging = undefined;
  };
  return stopConsoleLogging;
}
