// Model test: random quit sessions against the real quit drain.
//
// fast-check generates sessions of the commands below and runs each one on
// the real `createQuitDrain` (bounded-shutdown.ts), `quitWithExitFailSafe` /
// `retryQuitAfterDispatch` (quit-retry.ts) and `watchSystemShutdown`
// (system-shutdown.ts), wired the way index.ts wires them. Electron's `app`
// is `ElectronQuitModel`, the model of Electron's quit state machine that
// scripts/electron-quit-reentry-probe.mjs checks against the real runtime.
// Everything runs on the fake clock, including setImmediate, so a session's
// timing is exact and no test sleeps.
//
// Commands: ⌘Q, Dock → Quit and SIGTERM (native quits), a JavaScript
// `app.quit()`, an OS shutdown (powerMonitor `shutdown`), an update install
// (quitAndInstall), and the clock moving on. Per session, the flush settles
// in a microtask, in a macrotask, late (before or after the deadline), by
// rejecting, or never.
//
// The promise, for every session with at least one quit in it:
//
//   Electron emits will-quit and then quit, never window-all-closed; the
//   will-quit cleanup runs; the exit fail-safe never fires; and quit comes
//   within the drain's 10 s deadline of the first quit command, or within
//   the OS shutdown budget of a shutdown.
//
// Against #338's drain (d44ebb5 .. 673b9d4^), which resumed `app.quit()`
// from the flush's own promise chain, this fails within 1–13 runs and
// shrinks to `⌘Q` with a flush that settles in a microtask: Electron emits
// window-all-closed and only the fail-safe ends the process. Playwright quits
// from JavaScript, which never nests, so it cannot see this.
//
// Against main before `hurry` (048cb248), it failed within 1–46 runs on an
// OS shutdown whose flush outlasted system-shutdown.ts's 3 s exit: the drain
// still waited out its 10 s deadline, so app.exit(0) ended the process and
// will-quit never ran. The shutdown now cuts the flush to
// SYSTEM_SHUTDOWN_FLUSH_MS.
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createQuitDrain, QUIT_FLUSH_DEADLINE_MS } from "./bounded-shutdown";
import { quitWithExitFailSafe } from "./quit-retry";
import {
  SYSTEM_SHUTDOWN_EXIT_MS,
  SYSTEM_SHUTDOWN_FLUSH_MS,
  watchSystemShutdown
} from "./system-shutdown";
import { ElectronQuitModel } from "./test-support/electron-quit-model";

/**
 * The fake clock charges about 1 ms per setImmediate. Resuming the quit and
 * closing the windows takes a few, which are not a missed deadline.
 */
const HOPS_MS = 10;

const electron = vi.hoisted(() => ({
  app: undefined as ElectronQuitModel | undefined,
  shutdown: undefined as ((event: { preventDefault(): void }) => void) | undefined
}));

vi.mock("electron", () => ({
  app: {
    quit: () => electron.app!.quit(),
    exit: (code?: number) => electron.app!.exit(code),
    on: (name: string, listener: (event: { preventDefault(): void }) => void) =>
      electron.app!.on(name, listener)
  },
  powerMonitor: {
    on: (_name: string, handler: (event: { preventDefault(): void }) => void) => {
      electron.shutdown = handler;
    }
  }
}));
vi.mock("./logs", () => ({ logMain: vi.fn() }));

type Flush =
  | { kind: "microtask" }
  | { kind: "macrotask" }
  | { kind: "late"; ms: number }
  | { kind: "rejects" }
  | { kind: "never" };

/** `stop` for the drain: how the diagnostics flush settles. */
function stopFor(flush: Flush): () => Promise<void> {
  switch (flush.kind) {
    case "microtask":
      return async () => undefined;
    case "macrotask":
      return () => new Promise<void>((resolve) => setImmediate(resolve));
    case "late":
      return () => new Promise<void>((resolve) => setTimeout(resolve, flush.ms));
    case "rejects":
      return async () => {
        throw new Error("recorder failed to stop");
      };
    case "never":
      return () => new Promise<void>(() => undefined);
  }
}

/** One app process: the model Electron, and index.ts's wiring around it. */
class World {
  readonly app = new ElectronQuitModel(["main", "settings"]);
  stopCalls = 0;
  willQuitCleanups = 0;
  resumes = 0;
  firstQuitAt: number | undefined;
  shutdownAt: number | undefined;
  quitAt: number | undefined;
  updateStarted = false;
  updateFlushedAt: number | undefined;
  readonly drain: ReturnType<typeof createQuitDrain>;

  constructor(flush: Flush, hasPendingWork: boolean) {
    electron.app = this.app;
    electron.shutdown = undefined;
    // index.ts: watchSystemShutdown() runs first thing after app-ready.
    const systemShutdown = watchSystemShutdown("linux");
    const stop = stopFor(flush);
    this.drain = createQuitDrain({
      stop: () => {
        this.stopCalls += 1;
        return stop();
      },
      resumeQuit: () => {
        this.resumes += 1;
        quitWithExitFailSafe(this.app, { afterMs: 500, warn: () => undefined });
      },
      warn: () => undefined,
      hasPendingWork: () => hasPendingWork
    });
    this.app.on("before-quit", (event) => {
      this.drain.beforeQuit(event);
    });
    systemShutdown.beforeQuit(() => this.drain.hurry(SYSTEM_SHUTDOWN_FLUSH_MS));
    // agentAccess.dispose(): the cleanup a skipped will-quit would lose.
    this.app.on("will-quit", () => {
      this.willQuitCleanups += 1;
    });
    this.app.on("quit", () => {
      this.quitAt ??= Date.now();
      // Electron ends its message loop after `quit`: nothing still queued
      // runs, so a fail-safe armed earlier can never fire.
      vi.clearAllTimers();
    });
  }

  get running(): boolean {
    return !this.app.hasQuit && this.app.exitCode === null;
  }

  markQuitRequested(): void {
    this.firstQuitAt ??= Date.now();
  }

  /**
   * installDownloadedAppUpdate (auto-updater.ts), in its order. On Windows
   * and Linux, electron-updater's BaseUpdater.quitAndInstall queues
   * `app.quit()` on setImmediate. On macOS, Squirrel relaunches through
   * `[NSApp terminate:]`, a native quit.
   */
  async installUpdate(platform: NodeJS.Platform): Promise<void> {
    this.updateStarted = true;
    if (platform === "linux") {
      // The native package installs synchronously, then queues its quit
      // before PwrGit's flush starts; the drain must hold that quit.
      setImmediate(this.app.quit);
      await this.drain.flushForUpdate();
      this.updateFlushedAt = Date.now();
      this.app.quit();
      return;
    }
    await this.drain.flushForUpdate();
    this.updateFlushedAt = Date.now();
    if (platform === "darwin") await this.app.quitFromNativeTask();
    else setImmediate(this.app.quit);
  }
}

type Model = { world: World };
type Cmd = fc.AsyncCommand<Model, World>;

/** Let every microtask and zero-delay macrotask the command queued run. */
const drainQueues = () => vi.advanceTimersByTimeAsync(0);

class NativeQuit implements Cmd {
  constructor(readonly source: "⌘Q" | "Dock → Quit" | "SIGTERM") {}
  check(m: Readonly<Model>) {
    return m.world.running;
  }
  async run(_m: Model, w: World) {
    w.markQuitRequested();
    await w.app.quitFromNativeTask();
    await drainQueues();
  }
  toString() {
    return this.source;
  }
}

class JsQuit implements Cmd {
  check(m: Readonly<Model>) {
    return m.world.running;
  }
  async run(_m: Model, w: World) {
    w.markQuitRequested();
    w.app.quit();
    await drainQueues();
  }
  toString() {
    return "app.quit()";
  }
}

class OsShutdown implements Cmd {
  check(m: Readonly<Model>) {
    return m.world.running;
  }
  async run(_m: Model, w: World) {
    w.markQuitRequested();
    w.shutdownAt ??= Date.now();
    // powerMonitor emits from a native task; its app.quit() runs nested in
    // the handler, and the checkpoint follows the handler's return.
    electron.shutdown!({ preventDefault: () => undefined });
    await drainQueues();
  }
  toString() {
    return "OS shutdown";
  }
}

class UpdateInstall implements Cmd {
  constructor(readonly platform: "darwin" | "win32" | "linux") {}
  check(m: Readonly<Model>) {
    // One Restart click. Once a resumed quit is closing the windows, there is
    // no renderer left to click it.
    return m.world.running && !m.world.updateStarted && m.world.resumes === 0;
  }
  async run(_m: Model, w: World) {
    w.markQuitRequested();
    void w.installUpdate(this.platform);
    await drainQueues();
  }
  toString() {
    return `quitAndInstall(${this.platform})`;
  }
}

class Wait implements Cmd {
  constructor(readonly ms: number) {}
  check(m: Readonly<Model>) {
    return m.world.running;
  }
  async run() {
    await vi.advanceTimersByTimeAsync(this.ms);
  }
  toString() {
    return `wait ${this.ms} ms`;
  }
}

const flushArb: fc.Arbitrary<Flush> = fc.oneof(
  fc.constant({ kind: "microtask" as const }),
  fc.constant({ kind: "macrotask" as const }),
  fc.record({
    kind: fc.constant("late" as const),
    ms: fc.oneof(
      fc.integer({ min: 1, max: SYSTEM_SHUTDOWN_EXIT_MS - 1 }),
      fc.integer({ min: 1, max: 2 * QUIT_FLUSH_DEADLINE_MS })
    )
  }),
  fc.constant({ kind: "rejects" as const }),
  fc.constant({ kind: "never" as const })
);

const commandArbs = [
  fc.constantFrom("⌘Q", "Dock → Quit", "SIGTERM").map((source) => new NativeQuit(source)),
  fc.constant(new JsQuit()),
  fc.constant(new OsShutdown()),
  fc.constantFrom("darwin", "win32", "linux").map((platform) => new UpdateInstall(platform)),
  fc.integer({ min: 1, max: 12_000 }).map((ms) => new Wait(ms))
];

/** Run one session, settle everything, and return the world to judge. */
async function runSession(
  flush: Flush,
  hasPendingWork: boolean,
  commands: Iterable<Cmd>
): Promise<World> {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"]
  });
  const world = new World(flush, hasPendingWork);
  await fc.asyncModelRun(() => ({ model: { world }, real: world }), commands);
  // Past every deadline and fail-safe, so a stuck quit shows as stuck.
  await vi.advanceTimersByTimeAsync(4 * QUIT_FLUSH_DEADLINE_MS);
  return world;
}

function expectCleanQuit(w: World): void {
  if (w.firstQuitAt === undefined) {
    // Nothing asked to quit: nothing may have started to.
    expect(w.app.emitted).toEqual([]);
    return;
  }
  const { emitted } = w.app;
  expect(emitted).not.toContain("window-all-closed");
  expect(emitted.slice(-2)).toEqual(["will-quit", "quit"]);
  expect(w.willQuitCleanups).toBe(1);
  // Only the fail-safe calls app.exit().
  expect(w.app.exitCode).toBeNull();
  // Every subsystem latched its shutting-down state, once.
  expect(w.stopCalls).toBe(1);

  const deadline = Math.min(
    w.firstQuitAt + QUIT_FLUSH_DEADLINE_MS,
    w.shutdownAt === undefined ? Infinity : w.shutdownAt + SYSTEM_SHUTDOWN_EXIT_MS
  );
  expect(w.quitAt).toBeLessThanOrEqual(deadline + HOPS_MS);

  if (w.updateStarted) {
    // The updater owns the quit: it comes after the flush, and the drain
    // never issues its own app.quit (or that quit's fail-safe) ahead of it.
    expect(w.updateFlushedAt).toBeDefined();
    expect(w.quitAt).toBeGreaterThanOrEqual(w.updateFlushedAt!);
    expect(w.resumes).toBe(0);
  }
}

describe("quit drain (model: random quit sessions)", () => {
  afterEach(() => {
    vi.useRealTimers();
    electron.app = undefined;
  });

  it("every quit ends in will-quit → quit, with cleanup, without the fail-safe, in time", async () => {
    await fc.assert(
      fc.asyncProperty(
        flushArb,
        fc.boolean(),
        fc.commands(commandArbs, { maxCommands: 12 }),
        async (flush, hasPendingWork, commands) => {
          try {
            expectCleanQuit(await runSession(flush, hasPendingWork, commands));
          } finally {
            vi.useRealTimers();
          }
        }
      )
    );
  });

  // Shrunk counterexamples, kept so each regression has a name.

  it("completes ⌘Q when the flush settles in a microtask (#338 → #367)", async () => {
    const w = await runSession({ kind: "microtask" }, true, [new NativeQuit("⌘Q")]);
    expectCleanQuit(w);
    expect(w.app.emitted.filter((name) => name === "before-quit")).toHaveLength(2);
  });

  it("completes an OS shutdown whose flush never settles, before the exit fail-safe", async () => {
    // Before the drain could be hurried, it waited its full 10 s while
    // system-shutdown.ts exited at 3 s: app.exit(0), no will-quit, no quit.
    const w = await runSession({ kind: "never" }, true, [new OsShutdown()]);
    expectCleanQuit(w);
    expect(w.quitAt! - w.shutdownAt!).toBeLessThan(SYSTEM_SHUTDOWN_EXIT_MS);
  });

  it("completes an update install that an OS shutdown interrupts mid-flush", async () => {
    const w = await runSession({ kind: "never" }, false, [
      new UpdateInstall("darwin"),
      new OsShutdown()
    ]);
    expectCleanQuit(w);
  });
});

