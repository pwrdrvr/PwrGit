import { describe, expect, it, vi } from "vitest";
import { createQuitDrain } from "./bounded-shutdown";
import { quitWithExitFailSafe, retryQuitAfterDispatch } from "./quit-retry";
import { ElectronQuitModel } from "./test-support/electron-quit-model";

/** Defer the first quit at `stage`, then retry it the way `retry` says. */
function deferOnce(
  model: ElectronQuitModel,
  stage: "before-quit" | "will-quit",
  retry: "microtask" | "after-dispatch"
): void {
  let deferred = false;
  model.on(stage, (event) => {
    if (deferred) return;
    deferred = true;
    event.preventDefault();
    if (retry === "microtask") void Promise.resolve().then(model.quit);
    else void Promise.resolve().then(() => retryQuitAfterDispatch(model.quit));
  });
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Electron quit model (matches scripts/electron-quit-reentry-probe.mjs)", () => {
  it("loses a before-quit retry that settles in microtasks inside a native quit", async () => {
    const model = new ElectronQuitModel(["main"]);
    deferOnce(model, "before-quit", "microtask");
    await model.quitFromNativeTask();
    await model.settle();
    // What PwrGit 0.26.0 does on ⌘Q: two passes, the window closes, and
    // Electron reports window-all-closed instead of will-quit.
    expect(model.emitted).toEqual([
      "before-quit",
      "before-quit",
      "close:main",
      "closed:main",
      "window-all-closed"
    ]);
    expect(model.hasQuit).toBe(false);
  });

  it("does not lose the same retry when app.quit() came from JavaScript", async () => {
    const model = new ElectronQuitModel(["main"]);
    deferOnce(model, "before-quit", "microtask");
    model.quit();
    await model.settle();
    expect(model.hasQuit).toBe(true);
  });

  it("loses a will-quit retry that settles in microtasks, however the quit started", async () => {
    for (const start of ["native", "js"] as const) {
      const model = new ElectronQuitModel(["main"]);
      deferOnce(model, "will-quit", "microtask");
      if (start === "native") await model.quitFromNativeTask();
      else model.quit();
      await model.settle();
      expect(model.emitted.at(-1)).toBe("will-quit");
      expect(model.hasQuit).toBe(false);
    }
  });
});

describe("retryQuitAfterDispatch", () => {
  it.each(["before-quit", "will-quit"] as const)(
    "completes a native quit deferred at %s",
    async (stage) => {
      const model = new ElectronQuitModel(["main"]);
      deferOnce(model, stage, "after-dispatch");
      await model.quitFromNativeTask();
      await model.settle();
      expect(model.hasQuit).toBe(true);
      expect(model.emitted).not.toContain("window-all-closed");
    }
  );
});

describe("quit drain under a native ⌘Q", () => {
  /** index.ts's wiring, with the model standing in for `app`. */
  function wire(
    model: ElectronQuitModel,
    options: {
      stop?: () => Promise<void>;
      hasPendingWork?: () => boolean;
    } = {}
  ) {
    const warn = vi.fn();
    const stop = vi.fn(options.stop ?? (async () => undefined));
    const drain = createQuitDrain({
      stop,
      resumeQuit: () =>
        quitWithExitFailSafe(model, { afterMs: 50, warn }),
      warn: vi.fn(),
      ...(options.hasPendingWork !== undefined
        ? { hasPendingWork: options.hasPendingWork }
        : {})
    });
    model.on("before-quit", (event) => {
      drain.beforeQuit(event);
    });
    return { drain, stop, warn };
  }

  it("resumes a quit whose flush settles in microtasks, and Electron completes it", async () => {
    // Nothing recording and no agent open: stop() never touches I/O.
    const model = new ElectronQuitModel(["main", "settings"]);
    const s = wire(model);

    await model.quitFromNativeTask();
    await model.settle();
    await wait(80);

    expect(model.emitted.filter((name) => name === "before-quit")).toHaveLength(2);
    expect(model.emitted).not.toContain("window-all-closed");
    expect(model.emitted.slice(-2)).toEqual(["will-quit", "quit"]);
    // Electron quit on its own; the exit fail-safe never had to.
    expect(model.exitCode).toBeNull();
    expect(s.warn).not.toHaveBeenCalled();
  });

  it("resumes a quit whose flush waits on real I/O", async () => {
    const model = new ElectronQuitModel(["main"]);
    const s = wire(model, { stop: () => wait(5) });

    await model.quitFromNativeTask();
    await wait(10);
    await model.settle();

    expect(model.emitted.slice(-2)).toEqual(["will-quit", "quit"]);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it("does not defer at all when nothing is pending", async () => {
    const model = new ElectronQuitModel(["main"]);
    const s = wire(model, { hasPendingWork: () => false });

    await model.quitFromNativeTask();
    await model.settle();

    expect(model.emitted).toEqual([
      "before-quit",
      "close:main",
      "closed:main",
      "will-quit",
      "quit"
    ]);
    // Subsystems still latch their shutting-down state.
    expect(s.stop).toHaveBeenCalledOnce();
  });

  it("defers when something is pending", async () => {
    const model = new ElectronQuitModel(["main"]);
    wire(model, { hasPendingWork: () => true });

    await model.quitFromNativeTask();
    await model.settle();

    expect(model.emitted.filter((name) => name === "before-quit")).toHaveLength(2);
    expect(model.emitted.slice(-2)).toEqual(["will-quit", "quit"]);
  });
});

describe("quitWithExitFailSafe", () => {
  it("logs and exits when the resumed quit is swallowed", async () => {
    // Some later listener repeats the bug at will-quit.
    const model = new ElectronQuitModel(["main"]);
    deferOnce(model, "will-quit", "microtask");
    const warn = vi.fn();

    quitWithExitFailSafe(model, { afterMs: 20, warn });
    await model.settle();
    expect(model.hasQuit).toBe(false);
    await wait(40);

    expect(model.exitCode).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "quit had not completed 20 ms after resuming; exiting"
    );
  });
});
