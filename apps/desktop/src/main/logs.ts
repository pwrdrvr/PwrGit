import { appendFile, rename, stat } from "node:fs/promises";
import type { LogEntry, LogSnapshot } from "@pwrgit/shared";

// In-memory app log (PwrAgnt's Logs-system shape): a ring buffer the Logs
// window snapshots on open and follows live via the `logs:entry` event, plus
// a plain on-disk file for post-mortems. No electron imports here — the file
// path is injected from index.ts after app-ready — so unit tests can exercise
// the buffer without an Electron runtime.

const MAX_BUFFERED_LOG_ENTRIES = 5000;
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;

export type LogLevel = LogEntry["level"];

type LogListener = (entry: LogEntry) => void;

const entries = new Array<LogEntry | undefined>(MAX_BUFFERED_LOG_ENTRIES);
const listeners = new Set<LogListener>();
let nextSequence = 1;
let oldestIndex = 0;
let count = 0;
let dropped = 0;

let logFilePath: string | null = null;
// Serialize appends so lines never interleave; errors disable file logging
// rather than cascading (the in-memory buffer keeps working regardless).
let fileChain: Promise<void> = Promise.resolve();
let fileBroken = false;

/**
 * Start mirroring log lines to `path`. Called once from index.ts after
 * app-ready. A file already over the size cap is rotated to `<path>.old`
 * first so the log can't grow without bound.
 */
export function initLogFile(path: string): void {
  logFilePath = path;
  fileChain = fileChain.then(async () => {
    try {
      const info = await stat(path);
      if (info.size > MAX_LOG_FILE_BYTES) await rename(path, `${path}.old`);
    } catch {
      // Missing file (first run) — nothing to rotate.
    }
  });
}

export function getLogFilePath(): string | null {
  return logFilePath;
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

/** Append a line to the app log; fans out to buffer, file, and listeners. */
export function logMain(
  level: LogLevel,
  scope: string,
  ...parts: unknown[]
): LogEntry {
  const timestamp = Date.now();
  const text = parts.map(formatPart).join(" ");
  const line = `[${formatTimestamp(new Date(timestamp))}] [${level.padEnd(5)}] (${scope}) ${text}`;

  const entry: LogEntry = {
    sequence: nextSequence,
    timestamp,
    level,
    scope,
    line
  };
  nextSequence += 1;

  if (count < MAX_BUFFERED_LOG_ENTRIES) {
    entries[(oldestIndex + count) % entries.length] = entry;
    count += 1;
  } else {
    entries[oldestIndex] = entry;
    oldestIndex = (oldestIndex + 1) % entries.length;
    dropped += 1;
  }

  if (logFilePath !== null && !fileBroken) {
    const path = logFilePath;
    fileChain = fileChain.then(async () => {
      try {
        await appendFile(path, `${line}\n`);
      } catch {
        fileBroken = true;
      }
    });
  }

  for (const listener of listeners) listener(entry);
  return entry;
}

export function readLogSnapshot(): LogSnapshot {
  const ordered: LogEntry[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const entry = entries[(oldestIndex + offset) % entries.length];
    if (entry !== undefined) ordered.push(entry);
  }
  return { entries: ordered, truncated: dropped > 0, logFilePath };
}

/** Live-stream new entries (index.ts forwards them as `logs:entry` events). */
export function subscribeLogEntries(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetLogsForTests(): void {
  entries.fill(undefined);
  listeners.clear();
  nextSequence = 1;
  oldestIndex = 0;
  count = 0;
  dropped = 0;
  logFilePath = null;
  fileBroken = false;
}
