import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchSystemShutdown } from "./system-shutdown";

const electron = vi.hoisted(() => ({
  shutdown: undefined as ((event: { preventDefault(): void }) => void) | undefined,
  didQuit: undefined as (() => void) | undefined,
  app: {
    quit: vi.fn(),
    exit: vi.fn(),
    on: vi.fn()
  },
  powerMonitor: { on: vi.fn() }
}));
const logMain = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ app: electron.app, powerMonitor: electron.powerMonitor }));
vi.mock("./logs", () => ({ logMain }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  electron.shutdown = undefined;
  electron.didQuit = undefined;
  electron.powerMonitor.on.mockImplementation((_name, handler) => {
    electron.shutdown = handler;
  });
  electron.app.on.mockImplementation((_name, handler) => {
    electron.didQuit = handler;
  });
});

afterEach(() => vi.useRealTimers());

describe("system shutdown", () => {
  it.each(["linux", "darwin"] as const)(
    "holds %s shutdown until normal quit finishes without forcing an exit",
    (platform) => {
      watchSystemShutdown(platform);
      expect(electron.powerMonitor.on.mock.calls[0]?.[0]).toBe("shutdown");
      const preventDefault = vi.fn();
      electron.app.quit.mockImplementation(() => {
        // The OS shutdown delay must be held before any cleanup begins.
        expect(preventDefault).toHaveBeenCalledOnce();
        electron.didQuit?.();
      });

      electron.shutdown?.({ preventDefault });
      vi.advanceTimersByTime(5_000);

      expect(electron.app.quit).toHaveBeenCalledOnce();
      expect(electron.app.exit).not.toHaveBeenCalled();
      expect(logMain).toHaveBeenCalledWith("info", "app", "system shutdown requested; quitting");
      expect(logMain.mock.calls.some(([level]) => level === "warn")).toBe(false);
    }
  );

  it("exits before the OS deadline when a quit listener stalls cleanup", () => {
    watchSystemShutdown("linux");
    electron.shutdown?.({ preventDefault: vi.fn() });

    vi.advanceTimersByTime(2_999);
    expect(electron.app.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(electron.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logMain).toHaveBeenCalledWith("warn", "app", "system shutdown:", expect.any(String));
  });

  it("retains the delay for repeated notifications without restarting quit", () => {
    watchSystemShutdown("linux");
    const preventDefault = vi.fn();
    electron.shutdown?.({ preventDefault });
    vi.advanceTimersByTime(2_000);
    electron.shutdown?.({ preventDefault });
    vi.advanceTimersByTime(1_000);

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(electron.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("does not register the Linux/macOS notification on Windows", () => {
    watchSystemShutdown("win32");
    expect(electron.powerMonitor.on).not.toHaveBeenCalled();
  });
});
