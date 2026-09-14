import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electronLog from "electron-log/main.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetLogsForTests,
  initLogFile,
  logMain,
  readLogSnapshot,
  subscribeLogEntries
} from "./logs";

afterEach(() => {
  vi.restoreAllMocks();
  _resetLogsForTests();
});

describe("logMain", () => {
  it("formats a [ts] [level] (scope) line and buffers it", () => {
    logMain("error", "command", "remote:pull failed:", "git/exit_128", "boom");
    const snapshot = readLogSnapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.truncated).toBe(false);
    const entry = snapshot.entries[0];
    expect(entry.level).toBe("error");
    expect(entry.scope).toBe("command");
    expect(entry.line).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[error\] \(command\) remote:pull failed: git\/exit_128 boom$/
    );
  });

  it("stringifies non-string parts, including Errors", () => {
    logMain("warn", "git", "failed:", new Error("spawn ENOENT"), {
      code: 128
    });
    const entry = readLogSnapshot().entries[0];
    expect(entry.line).toContain("spawn ENOENT");
    expect(entry.line).toContain('{"code":128}');
  });

  it("assigns increasing sequences and notifies subscribers", () => {
    const seen: number[] = [];
    const off = subscribeLogEntries((entry) => seen.push(entry.sequence));
    logMain("info", "app", "one");
    logMain("info", "app", "two");
    off();
    logMain("info", "app", "three");
    expect(seen).toEqual([1, 2]);
    expect(readLogSnapshot().entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("drops the oldest entries past the buffer cap and reports truncation", () => {
    for (let i = 0; i < 5010; i += 1) logMain("info", "git", `line ${i}`);
    const snapshot = readLogSnapshot();
    expect(snapshot.entries).toHaveLength(5000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries[0].line).toContain("line 10");
    expect(snapshot.entries[4999].line).toContain("line 5009");
  });

  it("keeps error entries through a debug flood (separate debug quota)", () => {
    logMain("error", "command", "the error you came to find");
    for (let i = 0; i < 3000; i += 1) logMain("debug", "git", `probe ${i}`);
    const snapshot = readLogSnapshot();
    expect(snapshot.entries[0].level).toBe("error");
    expect(snapshot.entries.filter((e) => e.level === "debug")).toHaveLength(1000);
    expect(snapshot.truncated).toBe(true);
    // The merged stream stays sequence-ordered across both buffers.
    const sequences = snapshot.entries.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });
});

describe("initLogFile", () => {
  it("persists each scoped message once and streams the same line to the Logs window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrgit-logs-"));
    const path = join(dir, "main.log");
    await initLogFile(path);
    const seen: string[] = [];
    subscribeLogEntries((entry) => seen.push(entry.line));
    // Direct electron-log callers follow the same route as the logMain facade.
    electronLog.scope("fixture").info("native scoped log", { count: 2 });
    logMain("debug", "fixture", "debug probe");
    expect(readLogSnapshot().logFilePath).toBe(path);
    expect(seen).toHaveLength(2);
    expect((await readFile(path, "utf8")).trim().split(/\r?\n/)).toEqual(seen);
    expect(readLogSnapshot().entries.map((entry) => entry.line)).toEqual(seen);
  });

  it("rotates while running using electron-log's size limit and archive naming", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrgit-logs-"));
    const path = join(dir, "main.log");
    await initLogFile(path);
    logMain("info", "fixture", "x".repeat(2 * 1024 * 1024));
    logMain("warn", "fixture", "after rotation");
    expect(await readFile(join(dir, "main.old.log"), "utf8")).toContain("x".repeat(100));
    expect(await readFile(path, "utf8")).toBe(`${readLogSnapshot().entries[1].line}${process.platform === "win32" ? "\r\n" : "\n"}`);
    expect(readLogSnapshot().entries).toHaveLength(2);
  });

  it("keeps the Logs window usable when the file cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrgit-logs-"));
    const report = vi.spyOn(electronLog.transports.console, "writeFn").mockImplementation(() => {});
    // A directory cannot be opened as a log file on any supported platform.
    await initLogFile(dir);
    expect(() => logMain("error", "fixture", "must remain visible")).not.toThrow();
    expect(readLogSnapshot().entries[0].line).toContain("must remain visible");
    expect(report).toHaveBeenCalled();
  });

  it("adopts the log from a previous location, then keeps appending there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrgit-logs-"));
    const legacyPath = join(dir, "pwrgit-main.log");
    // Electron creates its default logs directory; this stands in for that.
    await mkdir(join(dir, "logs"));
    const path = join(dir, "logs", "main.log");
    await writeFile(legacyPath, "[old] earlier run\n");
    await writeFile(`${legacyPath}.old`, "[old] rotated run\n");

    await initLogFile(path, legacyPath);
    logMain("info", "app", "PwrGit 9.9.9 starting pid=311");

    const moved = await readFile(path, "utf8");
    expect(moved).toContain("[old] earlier run");
    await expect(readFile(legacyPath, "utf8")).rejects.toThrow();
    // The rotated sibling travels too, so nothing is left behind in userData.
    expect(await readFile(`${path}.old`, "utf8")).toContain("[old] rotated run");
    await expect(readFile(`${legacyPath}.old`, "utf8")).rejects.toThrow();
  });

  it("leaves an existing log at the new location alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrgit-logs-"));
    const legacyPath = join(dir, "pwrgit-main.log");
    const path = join(dir, "main.log");
    await writeFile(legacyPath, "[old] earlier run\n");
    await writeFile(path, "[new] current run\n");

    await initLogFile(path, legacyPath);
    logMain("info", "app", "PwrGit 9.9.9 starting pid=311");

    const current = await readFile(path, "utf8");
    expect(current).toContain("[new] current run");
    expect(current).not.toContain("[old] earlier run");
    expect(await readFile(legacyPath, "utf8")).toContain("[old] earlier run");
  });
});
