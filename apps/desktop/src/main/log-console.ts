import electronLog from "electron-log/main.js";
import { subscribeLogEntries } from "./logs";

let stopConsoleLogging: (() => void) | undefined;

function isClosedPipe(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}

/** Mirror the app log to the same console transport used by the Pwr siblings. */
export function initLogConsole(): () => void {
  if (stopConsoleLogging) return stopConsoleLogging;

  // logs.ts owns persistence and the Logs window. Disable the other transports
  // to avoid duplicate file writes or sending app logs into renderer consoles.
  electronLog.transports.file.level = false;
  // IPC is only present inside Electron, not in Node-based tests.
  if (electronLog.transports.ipc) electronLog.transports.ipc.level = false;
  electronLog.transports.remote.level = false;
  const transport = electronLog.transports.console;
  transport.level = process.env.VITEST === "true" ? false : "info";
  transport.format = "{text}";

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
  const unsubscribe = subscribeLogEntries((entry) => {
    electronLog[entry.level](entry.line);
  });
  stopConsoleLogging = () => {
    unsubscribe();
    process.stdout.off("error", onError);
    process.stderr.off("error", onError);
    transport.writeFn = originalWrite;
    transport.level = false;
    stopConsoleLogging = undefined;
  };
  return stopConsoleLogging;
}
