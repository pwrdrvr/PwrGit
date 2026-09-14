import { rename, stat } from "node:fs/promises";
import electronLog from "electron-log/main.js";
import type { LogEntry, LogSnapshot } from "@pwrgit/shared";

// electron-log owns console output, file writes, and rotation. The rings and
// listeners below supply Help → Logs snapshots and live events.

const MAX_BUFFERED_LOG_ENTRIES = 5000;
// Debug is dominated by routine git probes (upstream checks, cat-file -e
// misses) that arrive in bulk during scans — quota them separately so they
// can never evict the rare error/warn/info line the Logs window exists for.
const MAX_BUFFERED_DEBUG_ENTRIES = 1000;
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;

export type LogLevel = LogEntry["level"];

type LogListener = (entry: LogEntry) => void;

class Ring {
  private readonly slots: Array<LogEntry | undefined>;
  private oldestIndex = 0;
  private count = 0;
  dropped = 0;

  constructor(capacity: number) {
    this.slots = new Array<LogEntry | undefined>(capacity);
  }

  push(entry: LogEntry): void {
    if (this.count < this.slots.length) {
      this.slots[(this.oldestIndex + this.count) % this.slots.length] = entry;
      this.count += 1;
    } else {
      this.slots[this.oldestIndex] = entry;
      this.oldestIndex = (this.oldestIndex + 1) % this.slots.length;
      this.dropped += 1;
    }
  }

  /** Entries oldest→newest (sequence-ordered — pushes are sequential). */
  ordered(): LogEntry[] {
    const out: LogEntry[] = [];
    for (let offset = 0; offset < this.count; offset += 1) {
      const entry = this.slots[(this.oldestIndex + offset) % this.slots.length];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  reset(): void {
    this.slots.fill(undefined);
    this.oldestIndex = 0;
    this.count = 0;
    this.dropped = 0;
  }
}

const mainRing = new Ring(MAX_BUFFERED_LOG_ENTRIES);
const debugRing = new Ring(MAX_BUFFERED_DEBUG_ENTRIES);
const listeners = new Set<LogListener>();
let nextSequence = 1;

let logFilePath: string | null = null;
/** Preserve the pre-0.14 log location, then let electron-log own persistence. */
export async function initLogFile(path: string, legacyPath?: string): Promise<void> {
  if (legacyPath !== undefined && legacyPath !== path) {
    const absent = await stat(path).then(
      () => false,
      (cause: NodeJS.ErrnoException) => cause.code === "ENOENT"
    );
    if (absent) {
      await rename(legacyPath, path).catch(() => undefined);
      await rename(`${legacyPath}.old`, `${path}.old`).catch(() => undefined);
    }
  }
  electronLog.transports.file.resolvePathFn = () => path;
  logFilePath = path;
}

function formatTimestamp(date: Date): string {
  const pad = (v: number, w = 2): string => String(v).padStart(w, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function formatPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

type LogMessage = Parameters<(typeof electronLog.hooks)[number]>[0];

function formatLogLine(message: LogMessage): string {
  return `[${formatTimestamp(message.date)}] [${message.level.padEnd(5)}] (${message.scope ?? "app"}) ${message.data.map(formatPart).join(" ")}`;
}

// Match the siblings: scoped electron-log calls feed console/file transports,
// with a file hook supplying the app's Logs window exactly once per message.
// Keep PwrGit's debug collection and separate ring quota intact.
electronLog.transports.console.level = false;
electronLog.transports.console.format = ({ message }) => [formatLogLine(message)];
electronLog.transports.file.level = "debug";
electronLog.transports.file.maxSize = MAX_LOG_FILE_BYTES;
electronLog.transports.file.format = ({ message }) => [formatLogLine(message)];
if (electronLog.transports.ipc) electronLog.transports.ipc.level = false;
electronLog.transports.remote.level = false;
electronLog.scope.labelPadding = false;
electronLog.hooks.push((message, _transport, transportName) => {
  if (transportName !== "file") return message;
  const level: LogLevel = message.level === "error" || message.level === "warn" || message.level === "info"
    ? message.level : "debug";
  const entry: LogEntry = {
    sequence: nextSequence++,
    timestamp: message.date.getTime(),
    level,
    scope: message.scope ?? "app",
    line: formatLogLine(message)
  };
  (level === "debug" ? debugRing : mainRing).push(entry);
  for (const listener of listeners) listener(entry);
  // Startup messages and unit tests still reach the buffer before a file is
  // configured, without opening Electron's default file under another app name.
  return logFilePath === null ? false : message;
});

/** Compatibility facade for existing callers; electron-log dispatches outputs. */
export function logMain(level: LogLevel, scope: string, ...parts: unknown[]): void {
  electronLog.scope(scope)[level](...parts);
}

export function readLogSnapshot(): LogSnapshot {
  // Merge the two sequence-sorted rings back into one chronological stream.
  const main = mainRing.ordered();
  const debug = debugRing.ordered();
  const merged: LogEntry[] = [];
  let m = 0;
  let d = 0;
  while (m < main.length || d < debug.length) {
    const takeMain =
      d >= debug.length ||
      (m < main.length && main[m].sequence < debug[d].sequence);
    merged.push(takeMain ? main[m++] : debug[d++]);
  }
  return {
    entries: merged,
    truncated: mainRing.dropped > 0 || debugRing.dropped > 0,
    logFilePath
  };
}

/** Live-stream new entries (index.ts forwards them as `logs:entry` events). */
export function subscribeLogEntries(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetLogsForTests(): void {
  mainRing.reset();
  debugRing.reset();
  listeners.clear();
  nextSequence = 1;
  logFilePath = null;
}
