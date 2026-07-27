import { afterEach, describe, expect, it } from "vitest";
import {
  _resetLogsForTests,
  logMain,
  readLogSnapshot,
  subscribeLogEntries
} from "./logs";

afterEach(() => {
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
    const entry = logMain("warn", "git", "failed:", new Error("spawn ENOENT"), {
      code: 128
    });
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
    for (let i = 0; i < 5010; i += 1) logMain("debug", "git", `line ${i}`);
    const snapshot = readLogSnapshot();
    expect(snapshot.entries).toHaveLength(5000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries[0].line).toContain("line 10");
    expect(snapshot.entries[4999].line).toContain("line 5009");
  });
});
