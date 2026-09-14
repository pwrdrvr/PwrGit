import electronLog from "electron-log/main.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initLogConsole } from "./log-console";
import { _resetLogsForTests, logMain, readLogSnapshot } from "./logs";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
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
    const entries = (["debug", "info", "warn", "error"] as const).map((level) =>
      logMain(level, "fixture", `message at ${level}`)
    );
    expect(write.mock.calls.map(([options]) => options.message.level)).toEqual(["info", "warn", "error"]);
    expect(write.mock.calls.map(([options]) => options.message.data)).toEqual(
      entries.slice(1).map((entry) => [entry.line])
    );
    expect(readLogSnapshot().entries).toEqual(entries);
    expect(electronLog.transports.file.level).toBe(false);
    if (electronLog.transports.ipc) expect(electronLog.transports.ipc.level).toBe(false);
    expect(electronLog.transports.remote.level).toBe(false);
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
