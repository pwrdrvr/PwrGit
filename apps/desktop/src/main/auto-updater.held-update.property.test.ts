// Model test: random user sessions against the real auto-updater on Windows.
//
// fast-check generates sessions of the commands below and runs each on the
// real `auto-updater.ts` (fresh module per run, fake timers, stubbed fetch).
// Only electron-updater is faked, with the behaviour #467 and #468 describe
// from electron-updater 6.8.x's source:
//
//   - There is ONE pending cache dir for every track.
//   - Starting a download of a different version empties it, deleting the
//     installer already downloaded (`getValidCachedUpdateFile` sees a sha512
//     mismatch and calls `cleanCacheDirForPendingUpdate`).
//   - `downloadedUpdateHelper.file` still names that deleted installer until
//     a download failure calls `clear()`.
//   - The quit handler is added when a download lands with install-on-quit
//     on; on quit it runs `file` if install-on-quit is on then.
//
// The reference model is `newestEligible(feed, train)`: the release a check
// should offer. Invariants, after every command:
//
//   I1  A shown "Restart to vX" means vX's installer is on disk.
//   I2  Install-on-quit armed means the installer it would run is on disk.
//   I3  Restart runs only an installer that is on disk, and only the one the
//       button named.
//   I4  A completed manual check offers newestEligible.
//   I5  Automatic release-list requests keep the persisted budget across
//       restarts (#364): ten minutes after first launch, then hourly.
//
// Against the code before each fix, over 15 seeds: before #467 (a download
// ended every check) I4 failed within 1–63 runs; before #468 (a download on
// another track deleted the held installer) I1 failed within 1–102 runs. A
// store that forgets the persisted budget on launch, as before #364, fails I5
// in 2–3 runs, shrunk to a single `restart`. See `numRuns` for the budget.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppUpdateCheckResult, AppUpdateStatus } from "@pwrgit/shared";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_FIRST_CHECK_DELAY_MS
} from "./update-release-state";

type Handler = (...args: unknown[]) => void;
type Pending = {
  version: string;
  resolve: (files: string[]) => void;
  reject: (err: Error) => void;
};

const fake = vi.hoisted(() => {
  // Captured before the fake timers are installed.
  const macrotask = globalThis.setImmediate;
  /** Semver precedence for this file's tag pool: `X.Y.Z[-kind.N]`. */
  function compare(a: string, b: string): number {
    const parse = (v: string) => {
      const [core, pre] = v.replace(/^v/, "").split("-");
      return { core: core!.split(".").map(Number), pre };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) {
      if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
    }
    if (x.pre === y.pre) return 0;
    if (x.pre === undefined) return 1;
    if (y.pre === undefined) return -1;
    const [xk, xn] = x.pre.split(".");
    const [yk, yn] = y.pre.split(".");
    return xk !== yk ? (xk! < yk! ? -1 : 1) : Number(xn) - Number(yn);
  }

  const handlers = new Map<string, Set<Handler>>();
  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
  };

  /** One process's electron-updater, plus the disk that outlives it. */
  const state = {
    userData: "",
    /** The running app's version. */
    current: "1.0.0",
    /** Installers in the one pending cache dir. Survives restarts. */
    disk: new Set<string>(),
    /** `downloadedUpdateHelper.file`: may name a deleted installer. */
    file: undefined as string | undefined,
    quitHandlerAdded: false,
    feedTag: undefined as string | undefined,
    pending: undefined as Pending | undefined,
    /** Every installer `quitAndInstall` ran: its file, and whether it existed. */
    ran: [] as Array<{ file: string | undefined; onDisk: boolean }>,
    /** The status the renderer last received, i.e. what the toast shows. */
    shown: undefined as AppUpdateStatus | undefined,
    /** The trigger of the check that last reached the network, from its
     *  `checking for updates (<trigger>)` log line. */
    lastCheckTrigger: undefined as string | undefined,
    /** Misuse of electron-updater the fake caught. A throw alone would be
     *  swallowed by a background check's catch. */
    violations: [] as string[]
  };

  function landed(version: string): void {
    state.disk.add(version);
    state.file = version;
    emit("update-downloaded", { version });
    if (autoUpdater.autoInstallOnAppQuit) state.quitHandlerAdded = true;
  }

  const autoUpdater = {
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: undefined as unknown,
    get currentVersion() {
      return { version: state.current };
    },
    addAuthHeader: () => undefined,
    setFeedURL: ({ url }: { url: string }) => {
      state.feedTag = decodeURIComponent(/\/download\/([^/]+)\/$/.exec(url)![1]!);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
    },
    once: (event: string, handler: Handler) => {
      const wrapped: Handler & { original?: Handler } = (...args) => {
        handlers.get(event)?.delete(wrapped);
        handler(...args);
      };
      wrapped.original = handler;
      autoUpdater.on(event, wrapped);
    },
    removeListener: (event: string, handler: Handler) => {
      for (const h of handlers.get(event) ?? []) {
        if (h === handler || (h as { original?: Handler }).original === handler) {
          handlers.get(event)?.delete(h);
        }
      }
    },
    checkForUpdates: async () => {
      if (state.pending) {
        const message = `electron-updater checked again while ${state.pending.version} downloads`;
        state.violations.push(message);
        throw new Error(message);
      }
      emit("checking-for-update");
      const version = state.feedTag!.replace(/^v/, "");
      if (compare(version, state.current) <= 0) {
        emit("update-not-available", { version });
        return { isUpdateAvailable: false, updateInfo: { version } };
      }
      emit("update-available", { version });
      let downloadPromise: Promise<string[]>;
      if (state.disk.has(version)) {
        // A valid cached installer: no download. It still lands after file
        // I/O (`validateDownloadedPath` hashes it), not within this call.
        downloadPromise = new Promise((resolve) => macrotask(resolve)).then(() => {
          landed(version);
          return [];
        });
      } else {
        // The sha512 mismatch empties the one cache dir. `file` goes stale.
        state.disk.clear();
        downloadPromise = new Promise((resolve, reject) => {
          state.pending = { version, resolve, reject };
        });
      }
      return {
        isUpdateAvailable: true,
        updateInfo: { version },
        cancellationToken: { cancel: () => undefined },
        downloadPromise
      };
    },
    quitAndInstall: () => {
      state.ran.push({
        file: state.file,
        onDisk: state.file !== undefined && state.disk.has(state.file)
      });
    }
  };

  return {
    compare,
    macrotask,
    state,
    /** The userData files, by path: see the `node:fs` mock. */
    files: new Map<string, string>(),
    autoUpdater,
    downloadSucceeds(): void {
      const pending = state.pending!;
      state.pending = undefined;
      landed(pending.version);
      pending.resolve([]);
    },
    downloadFails(): void {
      const pending = state.pending!;
      state.pending = undefined;
      // `executeDownload`'s catch: `downloadedUpdateHelper.clear()`.
      state.file = undefined;
      state.disk.clear();
      const err = new Error("network failed");
      emit("error", err);
      pending.reject(err);
    },
    /** A new process: electron-updater's memory is gone, the disk is not. */
    newProcess(current: string): void {
      handlers.clear();
      state.current = current;
      state.file = undefined;
      state.quitHandlerAdded = false;
      state.feedTag = undefined;
      state.pending = undefined;
      state.shown = undefined;
      state.lastCheckTrigger = undefined;
      autoUpdater.autoInstallOnAppQuit = false;
    }
  };
});

// Speed, not behaviour: a run relaunches the module several times, and the
// Windows CI runner took 11.6 s for this file before these two changes.
//
// - `@pwrgit/shared` is the real module, loaded once. A mocked module survives
//   `vi.resetModules()`, so relaunches skip re-evaluating it.
// - The release-state file lives in memory. update-release-state.ts still
//   parses, validates and saves it, and it still outlives a relaunch, which is
//   what I5 needs. Its real-directory behaviour is covered by
//   auto-updater.test.ts. Every other path goes to the real fs.
vi.mock("@pwrgit/shared", async (importOriginal) => await importOriginal());
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const files = fake.files;
  const mine = (path: unknown) => String(path).startsWith(fake.state.userData);
  const fs = {
    ...real,
    mkdirSync: ((path, options) =>
      mine(path) ? undefined : real.mkdirSync(path, options)) as typeof real.mkdirSync,
    readFileSync: ((path, options) => {
      if (!mine(path)) return real.readFileSync(path, options);
      const data = files.get(String(path));
      if (data === undefined) {
        throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
      }
      return data;
    }) as typeof real.readFileSync,
    writeFileSync: ((path, data, options) => {
      if (!mine(path)) return real.writeFileSync(path, data, options);
      files.set(String(path), String(data));
    }) as typeof real.writeFileSync,
    renameSync: ((from, to) => {
      if (!mine(from)) return real.renameSync(from, to);
      files.set(String(to), files.get(String(from))!);
      files.delete(String(from));
    }) as typeof real.renameSync
  };
  return { ...fs, default: fs };
});
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => fake.state.userData, quit: () => undefined },
  autoUpdater: undefined
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: fake.autoUpdater } }));
vi.mock("./ipc", () => ({
  emitEvent: (channel: string, payload: unknown) => {
    if (channel === "app:updateStatus") fake.state.shown = payload as AppUpdateStatus;
  }
}));
vi.mock("./logs", () => ({
  logMain: (_level: string, _scope: string, message?: unknown) => {
    const trigger = /^checking for updates \((\w+)\)/.exec(String(message))?.[1];
    if (trigger) fake.state.lastCheckTrigger = trigger;
  }
}));

type Train = "stable" | "beta";
type Updater = typeof import("./auto-updater");

/** Already published when the app first launches; the installed version. */
const BASELINE = "v1.0.0";
/** Every tag a session can publish. The alpha and `-prerelease` are never
 *  eligible on a Latest track; they are there to be ignored. */
const TAG_POOL = [
  "v1.0.1",
  "v1.0.2",
  "v1.1.0",
  "v1.1.0-beta.1",
  "v1.1.0-beta.2",
  "v1.2.0-beta.1",
  "v1.1.0-alpha.1",
  "v1.0.3-prerelease.1"
] as const;

const coreOf = (tag: string) => tag.replace(/^v/, "").split("-")[0]!;
const maxTag = (tags: string[]) => [...tags].sort(fake.compare).at(-1)!;

/** The release a check on `train`'s Latest track should offer: Stable Latest
 *  is the newest final; Beta Latest is the newest `-beta.N` of a core newer
 *  than Stable Latest, else Stable Latest. */
function newestEligible(feed: ReadonlySet<string>, train: Train): string {
  const tags = [...feed];
  const stable = maxTag(tags.filter((tag) => !tag.includes("-")));
  if (train === "stable") return stable.slice(1);
  const betas = tags.filter(
    (tag) => /-beta\.\d+$/.test(tag) && fake.compare(coreOf(tag), coreOf(stable)) > 0
  );
  return maxTag([stable, ...betas]).slice(1);
}

type Model = { feed: Set<string>; train: Train; downloading: boolean };

type ManualCheck = {
  target: string;
  current: string;
  /** Started with no other check in flight, so it read the feed itself. */
  ownCheck: boolean;
  failuresAtStart: number;
  result?: AppUpdateCheckResult;
  error?: unknown;
  judged?: boolean;
};

/** Let the updater run until it waits on the user or the clock. Real
 *  macrotasks drain every queued microtask; the fake's cached landing takes
 *  one turn, and the updater may react to it with another. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise<void>((resolve) => fake.macrotask(resolve));
  }
}

class World {
  updater!: Updater;
  train: Train;
  readonly feed: Set<string>;
  readonly firstSeenAt: number;
  manualChecks: ManualCheck[] = [];
  failures = 0;
  lastFetchAt: number | undefined;
  readonly budgetViolations: string[] = [];

  constructor(feed: Set<string>, train: Train) {
    this.feed = feed;
    this.train = train;
    // A fresh installation, already due for its first automatic check.
    fake.files.clear();
    this.firstSeenAt = Date.now() - APP_UPDATE_FIRST_CHECK_DELAY_MS;
    writeFileSync(
      join(fake.state.userData, "update-release-state.json"),
      JSON.stringify({ version: 1, firstSeenAt: this.firstSeenAt, failures: 0 })
    );
    fake.state.disk.clear();
    fake.state.ran = [];
    fake.state.violations = [];
  }

  /** Stands in for GitHub's release list. */
  fetch = async (): Promise<Response> => {
    const now = Date.now();
    // Every check logs its trigger just before it reads the list. If that
    // line changes, every request counts as automatic and clicks fail I5
    // loudly, rather than automatic requests passing as clicks.
    const trigger = fake.state.lastCheckTrigger;
    if (trigger !== "manual" && trigger !== "menu") {
      const due = Math.max(
        this.firstSeenAt + APP_UPDATE_FIRST_CHECK_DELAY_MS,
        this.lastFetchAt === undefined ? 0 : this.lastFetchAt + APP_UPDATE_CHECK_INTERVAL_MS
      );
      if (now < due) {
        this.budgetViolations.push(`${trigger ?? "unlogged"} release-list request ${due - now} ms early`);
      }
    }
    this.lastFetchAt = now;
    const body = [...this.feed].map((tag) => {
      const version = tag.slice(1);
      return {
        tag_name: tag,
        draft: false,
        prerelease: version.includes("-"),
        assets: [
          { name: "latest.yml", state: "uploaded" },
          { name: `PwrGit-${version}-setup.exe`, state: "uploaded" }
        ]
      };
    });
    return {
      headers: new Headers(),
      ok: true,
      status: 200,
      json: async () => body
    } as Response;
  };

  /** Quit, then launch `current`: a new process on the same userData. */
  async launch(current: string): Promise<void> {
    // The old process's timers die with it. Clearing them also rewinds the
    // fake clock to where it started, and the budget is about the clock.
    const now = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(now);
    fake.newProcess(current);
    this.manualChecks = [];
    vi.resetModules();
    this.updater = await import("./auto-updater");
    this.updater.initAutoUpdater({
      resolveSelection: () => ({ train: this.train, channel: "latest" })
    });
    await settle();
  }
}

type Cmd = fc.AsyncCommand<Model, World>;

function syncModel(model: Model): void {
  model.downloading = fake.state.pending !== undefined;
}

function checkInvariants(world: World): void {
  const { state } = fake;
  if (state.shown?.status === "downloaded") {
    expect(state.disk, `I1: "Restart to v${state.shown.version}" is shown`).toContain(
      state.shown.version
    );
  }
  if (fake.autoUpdater.autoInstallOnAppQuit && state.quitHandlerAdded && state.file) {
    expect(state.disk, `I2: install-on-quit would run v${state.file}`).toContain(state.file);
  }
  for (const check of world.manualChecks) {
    if (check.judged || (check.result === undefined && check.error === undefined)) continue;
    check.judged = true;
    expect(check.error, "I4: a manual check rejected").toBeUndefined();
    if (!check.ownCheck) continue;
    const result = check.result!;
    const newer = fake.compare(check.target, check.current) > 0;
    const offered = `I4: a manual check offered ${JSON.stringify(result)}, newest eligible v${check.target}`;
    if (result.status === "downloaded") {
      expect(result.version, offered).toBe(check.target);
    } else if (result.status === "no-update") {
      expect(newer, offered).toBe(false);
    } else if (result.status === "error") {
      expect(world.failures, offered).toBeGreaterThan(check.failuresAtStart);
    } else {
      expect.fail(offered);
    }
  }
  expect(world.budgetViolations.join("; "), "I5: the persisted request budget").toBe("");
  expect(state.violations.join("; "), "the fake electron-updater").toBe("");
}

async function after(model: Model, world: World): Promise<void> {
  await settle();
  syncModel(model);
  checkInvariants(world);
}

class Publish implements Cmd {
  constructor(readonly tag: string) {}
  check = (m: Readonly<Model>) => !m.feed.has(this.tag);
  async run(m: Model, w: World) {
    m.feed.add(this.tag);
    w.feed.add(this.tag);
    await after(m, w);
  }
  toString = () => `publish(${this.tag})`;
}

/** Settings → Updates: pick a train (Latest track). */
class SelectTrain implements Cmd {
  constructor(readonly train: Train) {}
  check = (m: Readonly<Model>) => m.train !== this.train;
  async run(m: Model, w: World) {
    m.train = this.train;
    w.train = this.train;
    w.updater.handleUpdateSelectionChange();
    await after(m, w);
  }
  toString = () => `selectTrain(${this.train})`;
}

/** Check for Update. Does not wait for a download it starts. */
class ClickCheck implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    const record: ManualCheck = {
      target: newestEligible(m.feed, m.train),
      current: fake.state.current,
      ownCheck: fake.state.pending === undefined,
      failuresAtStart: w.failures
    };
    w.manualChecks.push(record);
    void w.updater.checkForAppUpdatesNow("manual").then(
      (result) => { record.result = result; },
      (error: unknown) => { record.error = error; }
    );
    await after(m, w);
  }
  toString = () => "clickCheck";
}

class DownloadSucceeds implements Cmd {
  check = (m: Readonly<Model>) => m.downloading;
  async run(m: Model, w: World) {
    fake.downloadSucceeds();
    await after(m, w);
  }
  toString = () => "downloadSucceeds";
}

class DownloadFails implements Cmd {
  check = (m: Readonly<Model>) => m.downloading;
  async run(m: Model, w: World) {
    w.failures++;
    fake.downloadFails();
    await after(m, w);
  }
  toString = () => "downloadFails";
}

/** Leave the app open for an hour: the periodic automatic check runs. */
class CheckAndWait implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    await after(m, w);
  }
  toString = () => "checkAndWait";
}

/** The toast's Restart button. Whatever it runs, the app relaunches into. */
class ClickRestart implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    const shown = fake.state.shown;
    const named = shown?.status === "downloaded" ? shown.version : undefined;
    const before = fake.state.ran.length;
    await w.updater.installDownloadedAppUpdate();
    const ran = fake.state.ran.slice(before);
    expect(ran.length, "I3: Restart ran more than one installer").toBeLessThanOrEqual(1);
    if (named === undefined) {
      expect(ran, "I3: Restart ran an installer no button named").toEqual([]);
    } else {
      expect(ran, `I3: "Restart to v${named}"`).toEqual([{ file: named, onDisk: true }]);
    }
    if (ran[0]?.onDisk) await w.launch(ran[0].file!);
    await after(m, w);
  }
  toString = () => "clickRestart";
}

/** Quit and relaunch. Install-on-quit, if armed, installs on the way out. */
class Restart implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    const { state } = fake;
    const installs =
      fake.autoUpdater.autoInstallOnAppQuit && state.quitHandlerAdded && state.file !== undefined
        ? state.file
        : undefined;
    // I2 already holds: an armed installer is on disk.
    await w.launch(installs ?? state.current);
    await after(m, w);
  }
  toString = () => "restart";
}

const trainArb = fc.constantFrom<Train>("stable", "beta");
const selectTrainArb = trainArb.map((train) => new SelectTrain(train));
const clickCheckArb = fc.constant(new ClickCheck());
const commandArbs = [
  fc.constantFrom(...TAG_POOL).map((tag) => new Publish(tag)),
  // Twice as likely as the rest: the bugs live where a train switch or a
  // click lands between a download starting and settling.
  selectTrainArb,
  selectTrainArb,
  clickCheckArb,
  clickCheckArb,
  fc.constant(new DownloadSucceeds()),
  fc.constant(new DownloadFails()),
  fc.constant(new CheckAndWait()),
  fc.constant(new ClickRestart()),
  fc.constant(new Restart())
];

/** What was published before the first launch, and the train it is on. */
const startArb = fc.record({
  published: fc.subarray([...TAG_POOL]),
  train: trainArb
});

const originalPlatform = process.platform;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  vi.useFakeTimers();
  // Never created: the `node:fs` mock keeps everything under it in memory.
  fake.state.userData = join(tmpdir(), `pwrgit-updater-model-${process.pid}`);
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
});

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

describe("auto-updater held-update model (Windows)", () => {
  it("never offers, arms or runs an installer that is gone, and checks offer the newest eligible release", async () => {
    await fc.assert(
      fc.asyncProperty(
        startArb,
        fc.commands(commandArbs, { size: "medium", maxCommands: 30 }),
        async (start, commands) => {
          const feed = new Set([BASELINE, ...start.published]);
          const world = new World(new Set(feed), start.train);
          Object.defineProperty(globalThis, "fetch", { configurable: true, value: world.fetch });
          await world.launch(BASELINE.slice(1));
          const model: Model = { feed, train: start.train, downloading: false };
          syncModel(model);
          checkInvariants(world);
          await fc.asyncModelRun(() => ({ model, real: world }), commands);
        }
      ),
      // Budget: about 2 ms a run on an M-series Mac, so 400 runs take under
      // 1 s here. The file must stay well under 10 s on Windows CI, where the
      // 20 s test timeout applies; see the mocks above for what that took.
      // Against the code before #468, 20 seeds first failed at a mean of 58
      // runs and at most 160, so 400 runs miss it about once in a thousand.
      // Sessions are "medium" (up to 30 commands): at the default size the
      // same bug took a mean of ~700 runs to find.
      { numRuns: 400 }
    );
  });
});
