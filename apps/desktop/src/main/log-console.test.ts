import electronLog from "electron-log/main.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initLogConsole } from "./log-console";
import { _resetLogsForTests, logMain, readLogSnapshot } from "./logs";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetLogsForTests();
});

describe("app console logging", () => {
  it("delivers info/warn/error through electron-log while retaining debug in the app log", () => {
    vi.stubEnv("VITEST", "false");
    const write = vi.spyOn(electronLog.transports.console, "writeFn").mockImplementation(() => {});
    stop = initLogConsole();
    expect(initLogConsole()).toBe(stop);
    (["debug", "info", "warn", "error"] as const).forEach((level) =>
      logMain(level, "fixture", `message at ${level}`)
    );
    const entries = readLogSnapshot().entries;
    expect(write.mock.calls.map(([options]) => options.message.level)).toEqual(["info", "warn", "error"]);
    expect(write.mock.calls.map(([options]) => options.message.data)).toEqual(
      entries.slice(1).map((entry) => [expect.stringMatching(
        new RegExp(`^\\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\(fixture\\) [›>] message at ${entry.level}$`)
      )])
    );
    expect(readLogSnapshot().entries).toEqual(entries);
    expect(electronLog.transports.file.level).toBe("debug");
    if (electronLog.transports.ipc) expect(electronLog.transports.ipc.level).toBe(false);
    expect(electronLog.transports.remote.level).toBe(false);
  });

  it("uses the default colored prefix in a terminal and keeps the Logs window plain", () => {
    vi.stubEnv("VITEST", "false");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 14, 16, 32, 25, 627));
    const transport = electronLog.transports.console;
    const previousStyles = transport.useStyles;
    const write = vi.spyOn(transport, "writeFn").mockImplementation(() => {});
    stop = initLogConsole();
    try {
      transport.useStyles = true;
      logMain("info", "app", "PwrGit starting");
      logMain("warn", "app", "fixture warning");
      const lines = write.mock.calls.map(([options]) => options.message.data.join(" "));
      expect(lines[0]).toContain("\u001b[36m16:32:25.627 (app)\u001b[0m");
      expect(lines[1]).toContain("\u001b[33m16:32:25.627 (app)\u001b[0m");
      expect(readLogSnapshot().entries[0].line).toBe(
        "[2026-09-14 16:32:25.627] [info ] (app) PwrGit starting"
      );
      transport.useStyles = false;
      logMain("info", "app", "redirected output");
      expect(write.mock.calls[2][0].message.data.join(" ")).toMatch(
        /^16:32:25\.627 \(app\) [›>] redirected output$/
      );
    } finally {
      transport.useStyles = previousStyles;
    }
  });

  it("keeps unit tests quiet", () => {
    const write = vi.spyOn(electronLog.transports.console, "writeFn").mockImplementation(() => {});
    stop = initLogConsole();
    logMain("error", "fixture", "buffered only");
    expect(write).not.toHaveBeenCalled();
    expect(readLogSnapshot().entries).toHaveLength(1);
  });

  it.each(["EPIPE", "ERR_STREAM_DESTROYED"])("survives synchronous %s and keeps buffering", (code) => {
    vi.stubEnv("VITEST", "false");
    const write = vi.spyOn(electronLog.transports.console, "writeFn").mockImplementation(() => {
      throw Object.assign(new Error("closed pipe"), { code });
    });
    stop = initLogConsole();
    expect(() => logMain("info", "fixture", "terminal closed")).not.toThrow();
    logMain("error", "fixture", "still buffered");
    expect(write).toHaveBeenCalledTimes(1);
    expect(electronLog.transports.console.level).toBe(false);
    expect(readLogSnapshot().entries).toHaveLength(2);
  });

  it.each(["stdout", "stderr"] as const)("survives asynchronous %s failure and removes its handler on stop", (streamName) => {
    vi.stubEnv("VITEST", "false");
    const stream = process[streamName];
    const previous = stream.listeners("error");
    stop = initLogConsole();
    const added = stream.listeners("error").filter((listener) => !previous.includes(listener));
    expect(added).toHaveLength(1);
    added[0](Object.assign(new Error("closed pipe"), { code: "EPIPE" }));
    expect(electronLog.transports.console.level).toBe(false);
    logMain("warn", "fixture", "still buffered");
    expect(readLogSnapshot().entries).toHaveLength(1);
    stop();
    stop = undefined;
    expect(stream.listeners("error")).toEqual(previous);
  });
});
