// A newer release published while an older update sits downloaded.
//
// A downloaded update used to end every later check, so someone who left the
// app open across two releases restarted into the older build only to be
// offered the newer one straight away. These pin that the newer release
// replaces it, and what each platform can still install while that happens
// (see `supersedingDownload` in auto-updater.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_UPDATE_FIRST_CHECK_DELAY_MS } from "./update-release-state";

type Handler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  function emitter() {
    const handlers = new Map<string, Set<Handler>>();
    const add = (event: string, handler: Handler): void => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    };
    return {
      handlers,
      on: (event: string, handler: Handler) => add(event, handler),
      once: (event: string, handler: Handler) => {
        const wrapped: Handler = (...args) => {
          handlers.get(event)?.delete(wrapped);
          handler(...args);
        };
        (wrapped as { original?: Handler }).original = handler;
        add(event, wrapped);
      },
      removeListener: (event: string, handler: Handler) => {
        for (const h of handlers.get(event) ?? []) {
          if (h === handler || (h as { original?: Handler }).original === handler) {
            handlers.get(event)?.delete(h);
          }
        }
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
      },
      count: (event: string) => handlers.get(event)?.size ?? 0
    };
  }
  const updaterEvents = emitter();
  const autoUpdater = {
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    addAuthHeader: vi.fn(),
    checkForUpdates: vi.fn(),
    currentVersion: { version: "1.0.0" },
    logger: undefined as unknown,
    on: (event: string, handler: Handler) => updaterEvents.on(event, handler),
    once: (event: string, handler: Handler) => updaterEvents.once(event, handler),
    removeListener: (event: string, handler: Handler) =>
      updaterEvents.removeListener(event, handler),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn()
  };
  return {
    updaterEvents,
    /** Electron's own `autoUpdater` — Squirrel.Mac on macOS. */
    native: emitter(),
    autoUpdater,
    emitEvent: vi.fn(),
    app: { isPackaged: true, getPath: vi.fn(), quit: vi.fn() }
  };
});

vi.mock("electron", () => ({ app: mocks.app, autoUpdater: mocks.native }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: mocks.autoUpdater } }));
vi.mock("./ipc", () => ({ emitEvent: mocks.emitEvent }));
vi.mock("./logs", () => ({ logMain: vi.fn() }));

const fetchMock = vi.fn();
const originalPlatform = process.platform;
const originalFetch = globalThis.fetch;
let userData: string;

function feed(tag: string): void {
  const version = tag.replace(/^v/, "");
  fetchMock.mockResolvedValue({
    headers: new Headers(),
    ok: true,
    status: 200,
    json: async () => [{
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [
        { name: "latest-mac.yml", state: "uploaded" },
        { name: `PwrGit-${version}-universal-mac.zip`, state: "uploaded" },
        { name: "latest.yml", state: "uploaded" },
        { name: `PwrGit-${version}-setup.exe`, state: "uploaded" }
      ]
    }]
  });
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // The updater attaches its own handlers; this one only keeps a rejection
  // the test causes from being reported before they run.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** electron-updater accepting `version` and starting its download. */
function offerDownload(version: string) {
  const download = deferred();
  const token = { cancel: vi.fn() };
  mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
    mocks.updaterEvents.emit("checking-for-update");
    mocks.updaterEvents.emit("update-available", { version });
    return {
      isUpdateAvailable: true,
      updateInfo: { version },
      cancellationToken: token,
      downloadPromise: download.promise
    };
  });
  return { download, token };
}

/** Boot with `held` (v1.0.1 by default) already downloaded over a running
 *  v1.0.0. */
async function bootWithDownloaded(held = "1.0.1") {
  feed("v1.0.1");
  const first = offerDownload("1.0.1");
  const updater = await import("./auto-updater");
  updater.initAutoUpdater({
    resolveSelection: () => ({ channel: "latest", train: "stable" })
  });
  await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1));
  mocks.updaterEvents.emit("update-downloaded", { version: held });
  first.download.resolve([]);
  // Joins the startup check, so it has settled before the test goes on.
  await expect(updater.checkForAppUpdatesNow("startup")).resolves.toEqual({
    status: "downloaded", version: held
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return updater;
}

type Updater = Awaited<ReturnType<typeof bootWithDownloaded>>;

/** Start a user-initiated check for v1.0.2, which downloads it over v1.0.1. */
async function startSupersede(
  updater: Updater,
  trigger: "manual" | "menu" = "manual"
) {
  feed("v1.0.2");
  const second = offerDownload("1.0.2");
  let settled = false;
  const check = updater.checkForAppUpdatesNow(trigger).finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2));
  return { ...second, check, settled: () => settled };
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  userData = mkdtempSync(join(tmpdir(), "pwrgit-updater-supersede-"));
  mocks.app.getPath.mockReturnValue(userData);
  // An installation already due for its first automatic check.
  writeFileSync(join(userData, "update-release-state.json"), JSON.stringify({
    version: 1, firstSeenAt: Date.now() - APP_UPDATE_FIRST_CHECK_DELAY_MS, failures: 0
  }));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  fetchMock.mockReset();
  mocks.updaterEvents.handlers.clear();
  mocks.native.handlers.clear();
  mocks.emitEvent.mockReset();
  mocks.autoUpdater.checkForUpdates.mockReset();
  mocks.autoUpdater.quitAndInstall.mockReset();
  mocks.autoUpdater.autoInstallOnAppQuit = false;
  mocks.autoUpdater.currentVersion = { version: "1.0.0" };
  setPlatform("darwin");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(userData, { recursive: true, force: true });
  setPlatform(originalPlatform);
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

describe("a newer release replaces a downloaded update", () => {
  it("keeps the downloaded update when the feed has nothing newer", async () => {
    const updater = await bootWithDownloaded();

    // The feed IS read now — that is the whole change — but the same release
    // starts nothing.
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded", version: "1.0.1"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A tag that does not parse is never "newer".
    feed("vnext");
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded", version: "1.0.1"
    });

    // A failed read does not undo the download either.
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded", version: "1.0.1"
    });

    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("keeps the automatic-check budget while a download is held", async () => {
    const updater = await bootWithDownloaded();
    feed("v1.0.2");

    // `skipped`, not the held build: see the next test for why.
    await expect(updater.checkForAppUpdatesNow("periodic")).resolves.toMatchObject({
      status: "skipped"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
  });

  it("a click joining a deferred startup check still reads the feed while a download is held", async () => {
    const updater = await bootWithDownloaded();
    feed("v1.0.2");
    const second = offerDownload("1.0.2");

    // A relaunch's startup check is within the budget and defers; a click
    // that lands on it re-runs only on a `skipped` answer.
    const startup = updater.checkForAppUpdatesNow("startup");
    const click = updater.checkForAppUpdatesNow("manual");
    await expect(startup).resolves.toMatchObject({ status: "skipped" });
    await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    mocks.native.emit("update-downloaded");
    await expect(click).resolves.toEqual({ status: "downloaded", version: "1.0.2" });
  });

  it("does not re-download over a held version that does not parse", async () => {
    // `compareSemver` sorts it below everything, so without a guard every
    // check would read any release as newer and download it again.
    const updater = await bootWithDownloaded("nightly");
    feed("v1.0.2");

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded", version: "nightly"
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + updater.APP_UPDATE_CHECK_INTERVAL_MS);
    await updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("lets Settings discover a release only when it is newer than the held download", async () => {
    const updater = await bootWithDownloaded();

    vi.setSystemTime(Date.now() + updater.APP_UPDATE_CHECK_INTERVAL_MS);
    await updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + updater.APP_UPDATE_CHECK_INTERVAL_MS);
    feed("v1.0.2");
    offerDownload("1.0.2");
    await updater.readAppUpdateReleaseVersions();
    await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2));
  });

  it("macOS offers the newer build only once Squirrel.Mac has staged it", async () => {
    const updater = await bootWithDownloaded();
    const second = await startSupersede(updater);

    mocks.updaterEvents.emit("download-progress", { percent: 40, transferred: 40, total: 100 });
    // Status reads and settings writes reconcile the held download. Neither
    // may put the older offer back over the newer download's progress.
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "downloading", version: "1.0.2" });
    updater.handleUpdateSelectionChange();
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "downloading", version: "1.0.2" });
    // Squirrel still has v1.0.1 staged, so install-on-quit stays armed: it is
    // also what makes MacUpdater ask Squirrel to stage v1.0.2.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);

    // electron-updater has the zip; Squirrel has not staged it, so a Restart
    // here would still install v1.0.1.
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "downloading", version: "1.0.2" });
    expect(second.settled()).toBe(false);

    mocks.native.emit("update-downloaded");
    await expect(second.check).resolves.toEqual({ status: "downloaded", version: "1.0.2" });
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.2" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
    expect(mocks.native.count("error")).toBe(0);

    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({ status: "restarting" });
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("macOS puts the older Restart offer back when the newer download is canceled", async () => {
    const updater = await bootWithDownloaded();
    const second = await startSupersede(updater);

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    expect(second.token.cancel).toHaveBeenCalledTimes(1);
    mocks.updaterEvents.emit("update-cancelled", { version: "1.0.2" });
    second.download.reject(new Error("cancelled"));

    await expect(second.check).resolves.toEqual({ status: "downloaded", version: "1.0.1" });
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("macOS puts the older Restart offer back when the newer download fails", async () => {
    const updater = await bootWithDownloaded();
    const second = await startSupersede(updater);

    mocks.updaterEvents.emit("error", new Error("socket hang up"));
    second.download.reject(new Error("socket hang up"));

    await expect(second.check).resolves.toEqual({ status: "downloaded", version: "1.0.1" });
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({ status: "restarting" });
  });

  it("macOS falls back to the older staged build when Squirrel.Mac fails to stage the newer one", async () => {
    const updater = await bootWithDownloaded();
    const second = await startSupersede(updater);
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);

    mocks.native.emit("error", new Error("code signature check failed"));

    await expect(second.check).resolves.toEqual({ status: "downloaded", version: "1.0.1" });
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
    expect(mocks.native.count("error")).toBe(0);
  });

  it("macOS stops waiting for Squirrel.Mac after a bounded time", async () => {
    const updater = await bootWithDownloaded();
    const second = await startSupersede(updater);
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

    await expect(second.check).resolves.toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
  });

  it("a user-initiated check reports the newer build, not the one it replaced", async () => {
    const updater = await bootWithDownloaded();
    const second = await startSupersede(updater, "manual");
    // Help → Check for Updates clicked mid-download joins the running check.
    const menu = updater.checkForAppUpdatesNow("menu");

    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    mocks.native.emit("update-downloaded");

    await expect(menu).resolves.toEqual({ status: "downloaded", version: "1.0.2" });
    await expect(second.check).resolves.toEqual({ status: "downloaded", version: "1.0.2" });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("Windows drops the older offer once its installer is replaced, and holds install-on-quit", async () => {
    setPlatform("win32");
    const updater = await bootWithDownloaded();
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    const second = await startSupersede(updater);

    // electron-updater has emptied the pending cache dir, older installer
    // included, while its own `downloadedUpdateHelper.file` still names it.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "available", version: "1.0.2" });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    await expect(updater.installDownloadedAppUpdate()).resolves.toMatchObject({ status: "error" });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    // No Squirrel step: the installer on disk is what runs.
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    await expect(second.check).resolves.toEqual({ status: "downloaded", version: "1.0.2" });
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.2" });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("Windows does not bring back the deleted older installer when the newer download fails", async () => {
    setPlatform("win32");
    const updater = await bootWithDownloaded();
    const second = await startSupersede(updater);

    mocks.updaterEvents.emit("error", new Error("network failed"));
    second.download.reject(new Error("network failed"));

    await expect(second.check).resolves.toEqual({ status: "error", message: "network failed" });
    expect(updater.readAppUpdateStatus()).toEqual({ status: "error", message: "network failed" });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({
      status: "error",
      message: "No downloaded update is ready to install."
    });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
