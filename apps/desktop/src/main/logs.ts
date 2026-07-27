import { appendFile, rename, stat } from "node:fs/promises";
import type { LogEntry, LogSnapshot } from "@pwrgit/shared";

// In-memory app log (PwrAgnt's Logs-system shape): a ring buffer the Logs
// window snapshots on open and follows live via the `logs:entry` event, plus
// a plain on-disk file for post-mortems. No electron imports here — the file
// path is injected from index.ts after app-ready — so unit tests can exercise
// the buffer without an Electron runtime.

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

  (level === "debug" ? debugRing : mainRing).push(entry);

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
  fileBroken = false;
}
