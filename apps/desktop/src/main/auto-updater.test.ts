import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UpdateEventHandler = (info?: {
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}) => void;

const updateEventHandlers = new Map<string, UpdateEventHandler>();
const checkForUpdatesMock = vi.fn();
const setFeedURLMock = vi.fn();
const emitEventMock = vi.fn();
const logMainMock = vi.fn();

const addAuthHeaderMock = vi.fn();

const autoUpdaterMock = {
  allowPrerelease: false,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  addAuthHeader: addAuthHeaderMock,
  checkForUpdates: checkForUpdatesMock,
  currentVersion: { version: "1.0.0-beta.7" },
  logger: undefined as unknown,
  on: vi.fn((event: string, handler: UpdateEventHandler) => {
    updateEventHandlers.set(event, handler);
  }),
  quitAndInstall: vi.fn(),
  setFeedURL: setFeedURLMock
};

// Mutable so a test can take the unpackaged path — dev and e2e launches run
// unpackaged, and must not reach GitHub.
const electronMock = vi.hoisted(() => ({ app: { isPackaged: true } }));

vi.mock("electron", () => electronMock);

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: autoUpdaterMock
  }
}));

vi.mock("./ipc", () => ({
  emitEvent: (...args: unknown[]) => emitEventMock(...args)
}));

vi.mock("./logs", () => ({
  logMain: (...args: unknown[]) => logMainMock(...args)
}));

async function importAutoUpdater() {
  return await import("./auto-updater");
}

function macUpdateAssets(version: string) {
  return [
    { name: "latest-mac.yml", state: "uploaded" },
    { name: `PwrGit-${version}-universal-mac.zip`, state: "uploaded" }
  ];
}

function githubRelease(
  tagName: string,
  options: {
    assets?: Array<{ name?: string; state?: string }>;
    draft?: boolean;
    prerelease?: boolean;
  } = {}
) {
  const version = tagName.replace(/^v/i, "");
  return {
    tag_name: tagName,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: options.assets ?? macUpdateAssets(version)
  };
}

function githubResponse(
  body: unknown,
  options: { headers?: Record<string, string>; status?: number } = {}
) {
  const status = options.status ?? 200;
  return {
    headers: new Headers(options.headers ?? {}),
    json: async () => body,
    ok: status >= 200 && status < 300,
    status
  };
}

function mockGitHubReleases(
  releases = [githubRelease("v1.0.0-beta.8")]
): void {
  fetchMock.mockResolvedValue(
    githubResponse(releases, { headers: { etag: 'W/"releases"' } })
  );
}

function rateLimitedResponse(resetAtMs: number) {
  return githubResponse(
    { message: "API rate limit exceeded" },
    {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(resetAtMs / 1_000))
      },
      status: 403
    }
  );
}

function requestHeader(callIndex: number, name: string): string | undefined {
  const init = fetchMock.mock.calls[callIndex]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers?.[name];
}

const fetchMock = vi.fn();

/** Let the microtask queue drain without leaning on the fake clock. */
async function delayTicks(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("auto updater", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPlatform = process.platform;
  const originalFetch = globalThis.fetch;
  const originalGhToken = process.env.GH_TOKEN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  let resolveChannel: "latest" | "prerelease" = "latest";
  let resolveTrain: "stable" | "beta" = "stable";

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform
    });
  }

  async function startUpdater() {
    const updater = await importAutoUpdater();
    updater.initAutoUpdater({
      resolveSelection: () => ({
        channel: resolveChannel,
        train: resolveTrain
      })
    });
    return updater;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    electronMock.app.isPackaged = true;
    setPlatform("darwin");
    process.env.NODE_ENV = "production";
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    resolveChannel = "latest";
    resolveTrain = "stable";
    updateEventHandlers.clear();
    emitEventMock.mockReset();
    checkForUpdatesMock.mockReset();
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0-beta.8" }
    });
    setFeedURLMock.mockReset();
    addAuthHeaderMock.mockReset();
    fetchMock.mockReset();
    mockGitHubReleases();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock
    });
    logMainMock.mockReset();
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = false;
    autoUpdaterMock.autoInstallOnAppQuit = false;
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.7" };
    autoUpdaterMock.logger = undefined;
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch
    });
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform
    });
  });

  it("checks on startup and then hourly", async () => {
    const updater = await startUpdater();

    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_CHECK_INTERVAL_MS);

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(2);
  });

  it("does not check again when an update is already downloaded for the selected channel", async () => {
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    checkForUpdatesMock.mockClear();

    const manualResult = await updater.checkForAppUpdatesNow("manual");

    expect(manualResult).toEqual({
      status: "downloaded",
      version: "1.0.0-beta.8"
    });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("checks again when the selected channel changes after an update is downloaded", async () => {
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    resolveChannel = "prerelease";
    checkForUpdatesMock.mockClear();

    const manualResult = await updater.checkForAppUpdatesNow("manual");

    expect(manualResult).toEqual({
      status: "available",
      version: "1.0.0-beta.8"
    });
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("does not offer a downloaded update after switching trains", async () => {
    resolveTrain = "beta";
    resolveChannel = "latest";
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.0.0")
    ]);
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.1.0-beta.2" }
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0" };
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.1.0-beta.2" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0-beta.2"
    });
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);

    resolveTrain = "stable";
    updater.reconcileDownloadedUpdateEligibility();

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "no-update",
      version: "1.0.0"
    });
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({
      status: "error",
      message: "The downloaded update is not for the selected channel."
    });
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

    resolveTrain = "beta";
    updater.reconcileDownloadedUpdateEligibility();

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0-beta.2"
    });
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
  });

  it("skips electron-updater on Linux package builds", async () => {
    setPlatform("linux");
    const updater = await startUpdater();
    const manualResult = await updater.checkForAppUpdatesNow();

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(autoUpdaterMock.on).not.toHaveBeenCalled();
    expect(manualResult).toEqual({
      status: "skipped",
      reason: "Linux builds are updated by installing a newer package."
    });
  });

  describe("dev/QA fake update", () => {
    // The dev binary is unsigned and has no release feed, so a user-initiated
    // check walks a fake through the status machine — the only way the update
    // toast is reachable without cutting a release.
    async function runDevCheck(
      updater: Awaited<ReturnType<typeof importAutoUpdater>>,
      trigger: "manual" | "menu" | "startup" | "periodic"
    ) {
      const pending = updater.checkForAppUpdatesNow(trigger);
      // Generous: the fake walks one delay per percent tick, and a short
      // advance would resolve nothing and time the test out rather than fail.
      await vi.advanceTimersByTimeAsync(10_000);
      return await pending;
    }

    function broadcastStatuses(): Array<{ status: string; percent?: number }> {
      return emitEventMock.mock.calls
        .filter(([channel]) => channel === "app:updateStatus")
        .map(([, payload]) => payload as { status: string; percent?: number });
    }

    beforeEach(() => {
      electronMock.app.isPackaged = false;
    });

    it("offers a fake download to a user-initiated check", async () => {
      const updater = await importAutoUpdater();

      const result = await runDevCheck(updater, "menu");

      expect(result).toEqual({ status: "downloaded", version: "420.0.0" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(checkForUpdatesMock).not.toHaveBeenCalled();
      // Every transition is broadcast, so the whole flow is watchable in dev.
      const statuses = broadcastStatuses();
      expect([
        ...new Set(statuses.map((entry) => entry.status))
      ]).toEqual(["checking", "available", "downloading", "downloaded"]);
      // And the download half is a RAMP, not a single frozen sample: the
      // toast's meter cannot be judged in dev against one 60% tick.
      const percents = statuses
        .filter((entry) => entry.status === "downloading")
        .map((entry) => entry.percent);
      expect(percents.length).toBeGreaterThan(3);
      expect(percents.at(0)).toBe(0);
      expect(percents.at(-1)).toBe(100);
      expect([...percents].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
        percents
      );
    });

    it("stops the fake download when the user cancels it", async () => {
      const updater = await importAutoUpdater();
      const pending = updater.checkForAppUpdatesNow("menu");
      // Far enough in to be downloading, not far enough to have finished.
      await vi.advanceTimersByTimeAsync(900);
      expect(updater.readAppUpdateStatus().status).toBe("downloading");

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toEqual({ status: "canceled", version: "420.0.0" });
      // Nothing is held, so no Restart is offered for an update that never
      // finished arriving.
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "canceled",
        version: "420.0.0"
      });
      expect(
        broadcastStatuses().some((entry) => entry.status === "downloaded")
      ).toBe(false);
    });

    it("takes a cancel pressed before the bytes start moving", async () => {
      // The toast offers Cancel from `available` onward. Main must already be
      // able to take one there, or the button sits on screen doing nothing
      // and the update installs anyway.
      const updater = await importAutoUpdater();
      const pending = updater.checkForAppUpdatesNow("menu");
      await vi.advanceTimersByTimeAsync(400);
      expect(updater.readAppUpdateStatus().status).toBe("available");

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toEqual({ status: "canceled", version: "420.0.0" });
      expect(
        broadcastStatuses().some((entry) => entry.status === "downloaded")
      ).toBe(false);
    });

    it("takes a cancel pressed on the last step of the download", async () => {
      const updater = await importAutoUpdater();
      const pending = updater.checkForAppUpdatesNow("menu");
      // Two phase steps plus every percent tick but the final delay.
      await vi.advanceTimersByTimeAsync(300 * 8 + 150);
      const percents = broadcastStatuses()
        .filter((entry) => entry.status === "downloading")
        .map((entry) => entry.percent);
      expect(percents.at(-1)).toBe(100);

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      await vi.advanceTimersByTimeAsync(10_000);

      // A cancel read only at the top of the loop would have been dropped
      // here, and the preview would offer a Restart the user just declined.
      expect(await pending).toEqual({ status: "canceled", version: "420.0.0" });
      expect(updater.readAppUpdateStatus().status).toBe("canceled");
    });

    it("answers a cancel with nothing to stop without inventing one", async () => {
      const updater = await importAutoUpdater();

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });

      await runDevCheck(updater, "menu");
      // The download is over; a click that lost the race must not rewrite the
      // offer the user now has.
      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "downloaded",
        version: "420.0.0"
      });
    });

    it("stays silent on startup and periodic checks", async () => {
      const updater = await importAutoUpdater();

      for (const trigger of ["startup", "periodic"] as const) {
        expect(await runDevCheck(updater, trigger)).toEqual({
          status: "skipped",
          reason: "auto-update disabled in development"
        });
      }
      // A dev launch — and the Playwright harness, also unpackaged — must never
      // raise an update toast on its own.
      expect(
        emitEventMock.mock.calls.some(
          ([, payload]) =>
            (payload as { status?: string })?.status === "downloaded"
        )
      ).toBe(false);
    });

    it("leaves a fake offer standing when the check is repeated", async () => {
      const updater = await importAutoUpdater();
      await runDevCheck(updater, "menu");
      emitEventMock.mockReset();

      const second = await runDevCheck(updater, "menu");

      expect(second).toEqual({ status: "downloaded", version: "420.0.0" });
      // Production short-circuits on a held download; tearing the offer back
      // down to `checking` would make the preview lie about the real flow.
      expect(emitEventMock).not.toHaveBeenCalled();
    });

    it("refuses to restart into a fake update", async () => {
      const updater = await importAutoUpdater();
      await runDevCheck(updater, "menu");

      expect(await updater.installDownloadedAppUpdate()).toEqual({
        status: "error",
        message:
          "Dev preview (v420.0.0): Restart only works in production builds."
      });
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });

    it("answers for the platform before offering a Linux preview", async () => {
      setPlatform("linux");
      const updater = await importAutoUpdater();

      // Linux never offers an in-app update in any build, so a dev preview
      // there would demo UI that platform cannot reach.
      expect(await runDevCheck(updater, "menu")).toEqual({
        status: "skipped",
        reason: "Linux builds are updated by installing a newer package."
      });
    });
  });

  it("pins electron-updater to the selected GitHub Release download feed", async () => {
    resolveChannel = "prerelease";
    mockGitHubReleases([githubRelease("v1.0.0-beta.36")]);
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0-beta.36" }
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.35" };
    const updater = await startUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.0-beta.36"
    });

    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrGit/releases/download/v1.0.0-beta.36/"
    });
    expect(addAuthHeaderMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("authenticates the pinned feed with GH_TOKEN", async () => {
    process.env.GH_TOKEN = "test-token";
    resolveChannel = "prerelease";
    mockGitHubReleases([githubRelease("v1.0.0-beta.36")]);
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0-beta.36" }
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.35" };
    const updater = await startUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.0-beta.36"
    });

    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrGit/releases/download/v1.0.0-beta.36/"
    });
    expect(addAuthHeaderMock).toHaveBeenCalledWith("token test-token");
  });

  describe.each(["darwin", "win32"] as const)("stable promotion on %s", (platform) => {
    describe.each(["1.1.0-alpha.7", "1.1.0-beta.5"])("installed %s", (installed) => {
      describe.each(["stable", "beta"] as const)("%s train", (train) => {
        it.each(["latest", "prerelease"] as const)("promotes on %s without changing selection", async (channel) => {
          setPlatform(platform);
          resolveTrain = train;
          resolveChannel = channel;
          autoUpdaterMock.currentVersion = { version: installed };
          const final = githubRelease("v1.1.0", {
            assets: platform === "darwin" ? macUpdateAssets("1.1.0") : [
              { name: "latest.yml", state: "uploaded" },
              { name: "PwrGit-1.1.0-setup.exe", state: "uploaded" }
            ]
          });
          mockGitHubReleases([
            githubRelease("v1.1.0-beta.5", { prerelease: true }),
            final,
            githubRelease("v1.1.0-alpha.7", { prerelease: true })
          ]);
          checkForUpdatesMock.mockResolvedValue({
            isUpdateAvailable: true,
            updateInfo: { version: "1.1.0" }
          });
          const updater = await startUpdater();
          await vi.waitFor(() => expect(checkForUpdatesMock).toHaveBeenCalledTimes(1));
          await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_CHECK_INTERVAL_MS);
          expect(checkForUpdatesMock).toHaveBeenCalledTimes(2);
          for (const trigger of ["manual", "menu"] as const) {
            await expect(updater.checkForAppUpdatesNow(trigger)).resolves.toEqual({
              status: "available", version: "1.1.0"
            });
          }
          expect(checkForUpdatesMock).toHaveBeenCalledTimes(4);
          expect(setFeedURLMock).toHaveBeenLastCalledWith({
            provider: "generic",
            url: "https://github.com/pwrdrvr/PwrGit/releases/download/v1.1.0/"
          });
          const versions = await updater.readAppUpdateReleaseVersions();
          expect(versions.beta.latest.version).toBe("v1.1.0");
          expect(versions.beta.prerelease.version).toBe("v1.1.0");
          expect(autoUpdaterMock.allowPrerelease).toBe(train === "beta" || channel === "prerelease");
          updateEventHandlers.get("update-downloaded")?.({ version: "1.1.0" });
          expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.1.0" });
        });
      });
    });
  });

  it("pins the beta train to the smoke-checked main-train tag", async () => {
    resolveTrain = "beta";
    resolveChannel = "latest";
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.1.0-alpha.7", { prerelease: true }),
      githubRelease("v1.0.0")
    ]);
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.1.0-beta.2" }
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0" };
    const updater = await startUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.1.0-beta.2"
    });
    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrGit/releases/download/v1.1.0-beta.2/"
    });
    expect(autoUpdaterMock.allowPrerelease).toBe(true);
  });

  it("does not ask electron-updater to check a tag-only newer release", async () => {
    resolveChannel = "prerelease";
    mockGitHubReleases([githubRelease("v1.0.0-beta.36")]);
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.36" };
    const updater = await importAutoUpdater();
    updater.initAutoUpdater({
      resolveSelection: () => ({
        channel: resolveChannel,
        train: resolveTrain
      })
    });

    const manualResult = await updater.checkForAppUpdatesNow("manual");

    expect(manualResult).toEqual({
      status: "no-update",
      version: "1.0.0-beta.36"
    });
    expect(setFeedURLMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("ignores assetless GitHub Releases when selecting an update feed", async () => {
    resolveChannel = "prerelease";
    mockGitHubReleases([
      githubRelease("v1.0.0-beta.37", { assets: [] }),
      githubRelease("v1.0.0-beta.36")
    ]);
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0-beta.36" }
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.35" };
    const updater = await importAutoUpdater();
    updater.initAutoUpdater({
      resolveSelection: () => ({
        channel: resolveChannel,
        train: resolveTrain
      })
    });

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.0-beta.36"
    });

    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrGit/releases/download/v1.0.0-beta.36/"
    });
  });

  it("treats isUpdateAvailable=false as no-update even when the version is newer", async () => {
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: "1.0.0-beta.8" }
    });
    const updater = await startUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "no-update",
      version: "1.0.0-beta.8"
    });
  });

  it("does not join an in-flight check for a different train", async () => {
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.0.0")
    ]);
    autoUpdaterMock.currentVersion = { version: "0.9.0" };
    const firstCheck = createDeferred<{
      isUpdateAvailable: boolean;
      updateInfo: { version: string };
    }>();
    checkForUpdatesMock
      .mockReturnValueOnce(firstCheck.promise)
      .mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: { version: "1.1.0-beta.2" }
      });
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });

    resolveTrain = "beta";
    const betaCheck = updater.checkForAppUpdatesNow("manual");
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);

    firstCheck.resolve({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0" }
    });
    await expect(betaCheck).resolves.toEqual({
      status: "available",
      version: "1.1.0-beta.2"
    });
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(2);
    expect(setFeedURLMock).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrGit/releases/download/v1.1.0-beta.2/"
    });
  });

  it("holds the in-flight lock until the automatic download finishes", async () => {
    const download = createDeferred<string[]>();
    checkForUpdatesMock.mockImplementation(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0-beta.8" },
      downloadPromise: (async () => {
        const files = await download.promise;
        updateEventHandlers.get("update-downloaded")?.({
          version: "1.0.0-beta.8"
        });
        return files;
      })()
    }));
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });

    const joined = updater.checkForAppUpdatesNow("manual");
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);

    download.resolve(["/tmp/PwrGit-update"]);
    await expect(joined).resolves.toEqual({
      status: "downloaded",
      version: "1.0.0-beta.8"
    });
  });

  it("cancels a download the user stopped without calling it a failure", async () => {
    const download = createDeferred<string[]>();
    const cancel = vi.fn(() => {
      download.reject(new Error("cancelled"));
    });
    checkForUpdatesMock.mockImplementation(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0-beta.8" },
      cancellationToken: { cancel },
      downloadPromise: download.promise
    }));
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });

    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "canceled",
        version: "1.0.0-beta.8"
      });
    });
  });

  it("aborts a download that had not handed over its token yet", async () => {
    // `update-available` — the status that puts Cancel on screen — is emitted
    // from inside `checkForUpdates`, which does not resolve (and so does not
    // yield its cancellationToken) until the download is already under way.
    const download = createDeferred<string[]>();
    const cancel = vi.fn(() => {
      download.reject(new Error("cancelled"));
    });
    let released: (() => void) | undefined;
    const reachedUpdater = new Promise<void>((resolve) => {
      released = resolve;
    });
    checkForUpdatesMock.mockImplementation(async () => {
      released?.();
      await delayTicks();
      return {
        isUpdateAvailable: true,
        updateInfo: { version: "1.0.0-beta.8" },
        cancellationToken: { cancel },
        downloadPromise: download.promise
      };
    });
    const updater = await startUpdater();
    await reachedUpdater;

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });

    // The token arrives after the click; the cancel must be applied to it
    // rather than discarded.
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "canceled",
        version: "1.0.0-beta.8"
      });
    });
  });

  it("still reports a download that broke on its own as an error", async () => {
    // The rejection looks identical to a cancel's; only our own flag tells
    // them apart, so a genuine failure must not be swallowed as "canceled".
    checkForUpdatesMock.mockImplementation(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.0-beta.8" },
      cancellationToken: { cancel: vi.fn() },
      downloadPromise: Promise.reject(new Error("socket hang up"))
    }));
    const updater = await startUpdater();

    await expect(updater.checkForAppUpdatesNow("menu")).resolves.toEqual({
      status: "error",
      message: "socket hang up"
    });
  });

  it("carries the download's byte counts to the toast, not just a percent", async () => {
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(updateEventHandlers.has("download-progress")).toBe(true);
    });

    updateEventHandlers.get("update-available")?.({ version: "1.0.0-beta.8" });
    updateEventHandlers.get("download-progress")?.({
      percent: 42.4,
      transferred: 50_000_000,
      total: 118_000_000,
      bytesPerSecond: 3_300_000
    });

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloading",
      version: "1.0.0-beta.8",
      percent: 42,
      transferred: 50_000_000,
      total: 118_000_000,
      bytesPerSecond: 3_300_000
    });
  });

  it("settles on canceled when electron-updater reports its own abort", async () => {
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(updateEventHandlers.has("update-cancelled")).toBe(true);
    });

    updateEventHandlers.get("update-cancelled")?.({ version: "1.0.0-beta.8" });

    // Not `available`, which promises a download is under way, and not
    // `error`, which claims something broke.
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "canceled",
      version: "1.0.0-beta.8"
    });
  });

  it("keeps a held download when a cancel arrives for something else", async () => {
    const updater = await startUpdater();
    await vi.waitFor(() => {
      expect(updateEventHandlers.has("update-downloaded")).toBe(true);
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.1.0" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0"
    });

    updateEventHandlers.get("update-cancelled")?.({ version: "1.0.0-beta.8" });

    // The Restart the user has already been offered is still good.
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0"
    });
  });

  it("does not reach GitHub from an unpackaged build", async () => {
    // Dev launches and the Playwright e2e harness both run unpackaged, and
    // Settings -> Updates reads release versions on mount.
    electronMock.app.isPackaged = false;
    const updater = await importAutoUpdater();

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(versions.stable.latest.unavailableReason).toBe(
      "Release versions are not fetched in development builds."
    );
    expect(versions.beta.prerelease.unavailableReason).toBe(
      "Release versions are not fetched in development builds."
    );
  });

  it("serves renderer release reads from the main-process cache", async () => {
    const updater = await importAutoUpdater();

    const first = await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.stable.latest.version).toBe("v1.0.0-beta.8");
  });

  it("shares one request between concurrent release readers", async () => {
    const updater = await importAutoUpdater();

    const [versions, release] = await Promise.all([
      updater.readAppUpdateReleaseVersions(),
      updater.checkForAppUpdatesNow("periodic")
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(versions.stable.latest.version).toBe("v1.0.0-beta.8");
    expect(release.status).not.toBe("error");
  });

  it("refetches once the cache entry expires", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(
      updater.APP_UPDATE_RELEASE_CACHE_TTL_MS + 1
    );
    await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["manual", "menu"] as const)(
    "revalidates a %s check conditionally and keeps the cached list on 304",
    async (trigger) => {
      const updater = await importAutoUpdater();
      await updater.readAppUpdateReleaseVersions();
      fetchMock.mockResolvedValueOnce(
        githubResponse(undefined, { status: 304 })
      );

      const result = await updater.checkForAppUpdatesNow(trigger);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestHeader(1, "If-None-Match")).toBe('W/"releases"');
      expect(result.status).not.toBe("error");
    }
  );

  it("reports the rate-limit reset time instead of a bare 403", async () => {
    const updater = await importAutoUpdater();
    fetchMock.mockResolvedValue(rateLimitedResponse(Date.now() + 30 * 60 * 1_000));

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(versions.stable.latest.unavailableReason).toMatch(
      /GitHub rate limit reached\. Update checks resume at /
    );
    expect(versions.stable.latest.unavailableReason).not.toMatch(/403/);
  });

  it("backs off on a secondary rate limit, which keeps its hourly budget", async () => {
    const updater = await importAutoUpdater();
    // GitHub's abuse-detection limit answers 403 with Retry-After and leaves
    // x-ratelimit-remaining untouched.
    fetchMock.mockResolvedValue(
      githubResponse(
        { message: "You have exceeded a secondary rate limit" },
        {
          headers: { "retry-after": "60", "x-ratelimit-remaining": "59" },
          status: 403
        }
      )
    );

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(versions.stable.latest.unavailableReason).toMatch(
      /GitHub rate limit reached\. Update checks resume at /
    );
    expect(versions.stable.latest.unavailableReason).not.toMatch(/403/);

    // The window has not passed, so a follow-up read must not re-request.
    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reports a plain 403 that carries no rate-limit headers", async () => {
    const updater = await importAutoUpdater();
    fetchMock.mockResolvedValue(
      githubResponse({ message: "Forbidden" }, { status: 403 })
    );

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(versions.stable.latest.unavailableReason).toBe(
      "GitHub releases request failed with 403"
    );
  });

  it("does not reject a background check when rate limited with no cache", async () => {
    // Nothing awaits the startup/periodic checks, so a rejection here would
    // surface as an unhandled rejection in main.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      fetchMock.mockResolvedValue(
        rateLimitedResponse(Date.now() + 30 * 60 * 1_000)
      );
      const updater = await startUpdater();
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      // The hourly tick throws from the backoff branch without a request.
      await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_CHECK_INTERVAL_MS);
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
  });

  it("stops requesting while rate limited and serves the last good list", async () => {
    const updater = await importAutoUpdater();
    await updater.readAppUpdateReleaseVersions();
    fetchMock.mockResolvedValue(rateLimitedResponse(Date.now() + 30 * 60 * 1_000));
    await vi.advanceTimersByTimeAsync(
      updater.APP_UPDATE_RELEASE_CACHE_TTL_MS + 1
    );

    // One request discovers the limit; later reads must not spend another.
    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const stale = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stale.stable.latest.version).toBe("v1.0.0-beta.8");
    expect(stale.stable.latest.unavailableReason).toBeUndefined();
  });

  it("resumes requesting after the rate-limit window passes", async () => {
    const updater = await importAutoUpdater();
    fetchMock.mockResolvedValue(rateLimitedResponse(Date.now() + 30 * 60 * 1_000));

    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);
    mockGitHubReleases();
    const recovered = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recovered.stable.latest.version).toBe("v1.0.0-beta.8");
  });

  it("installs a downloaded update that still matches the selected train", async () => {
    const updater = await startUpdater();
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });

    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({
      status: "restarting"
    });
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe("compareSemver", () => {
  it("orders by major/minor/patch", async () => {
    const { compareSemver } = await import("./auto-updater");
    expect(compareSemver("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("v1.2.0", "v1.10.0")).toBeLessThan(0);
    expect(compareSemver("v1.2.3", "v1.2.3")).toBe(0);
  });

  it("treats stable as higher precedence than prerelease at the same core", async () => {
    const { compareSemver } = await import("./auto-updater");
    expect(compareSemver("v1.0.0", "v1.0.0-beta.8")).toBeGreaterThan(0);
    expect(compareSemver("v1.0.0-beta.8", "v1.0.0")).toBeLessThan(0);
  });

  it("orders numeric prerelease identifiers numerically, not lexically", async () => {
    const { compareSemver } = await import("./auto-updater");
    expect(compareSemver("v1.0.0-beta.9", "v1.0.0-beta.10")).toBeLessThan(0);
    expect(compareSemver("v1.0.0-beta.2", "v1.0.0-beta.1")).toBeGreaterThan(0);
  });

  it("sorts unparseable tags below valid versions", async () => {
    const { compareSemver } = await import("./auto-updater");
    expect(compareSemver("not-a-version", "v1.0.0-beta.1")).toBeLessThan(0);
    expect(compareSemver("v0.0.1", "garbage")).toBeGreaterThan(0);
  });
});

describe("selectChannelReleases", () => {
  it("picks the highest-precedence stable for latest and never lets prerelease go backwards", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.0.0-beta.8", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.2", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.1", prerelease: true, draft: false }
    ];
    const { latest, prerelease } = selectChannelReleases(releases);
    expect(latest?.tag_name).toBe("v1.0.0-beta.8");
    expect(prerelease?.tag_name).toBe("v1.0.0-beta.8");
  });

  it("prefers a higher prerelease over latest stable when one exists", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.0.0-beta.9", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.8", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.1", prerelease: true, draft: false }
    ];
    const { latest, prerelease } = selectChannelReleases(releases);
    expect(latest?.tag_name).toBe("v1.0.0-beta.8");
    expect(prerelease?.tag_name).toBe("v1.0.0-beta.9");
  });

  it("classifies main-train alpha and beta without stealing stable latest", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.1.0-beta.2", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.1-prerelease.1", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.41", prerelease: true, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.0");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.1-prerelease.1");
    expect(selected.betaLatest?.tag_name).toBe("v1.1.0-beta.2");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-beta.2");
    expect(selected.latest?.tag_name).toBe("v1.0.0");
    expect(selected.prerelease?.tag_name).toBe("v1.0.1-prerelease.1");
  });

  it("keeps legacy 1.0 beta prereleases on the stable prerelease track", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.0.0-beta.41", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.8", prerelease: false, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.0-beta.8");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.0-beta.41");
    expect(selected.betaLatest?.tag_name).toBe("v1.0.0-beta.8");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.0.0-beta.8");
  });

  it("promotes a same-core alpha to beta latest once the beta tag exists", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.1.0-beta.1", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.betaLatest?.tag_name).toBe("v1.1.0-beta.1");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-beta.1");
  });

  it("does not put shipped 1.0.0-beta tags on the Beta train after 1.0.1", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.0.1", prerelease: false, draft: false },
      { tag_name: "v1.0.1-prerelease.5", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.50", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.48", prerelease: true, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.1");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.1");
    expect(selected.betaLatest?.tag_name).toBe("v1.0.1");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.0.1");
  });

  it("does not advertise leftover same-core betas after that train becomes Latest", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.1.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-beta.3", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.1", prerelease: false, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0");
  });

  it("keeps a newer main-train alpha on Beta after Stable is promoted", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.1.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-beta.3", prerelease: true, draft: false },
      { tag_name: "v1.2.0-alpha.1", prerelease: true, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.2.0-alpha.1");
  });

  it("shows an alpha as beta prerelease before a beta exists", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.betaLatest?.tag_name).toBe("v1.0.0");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-alpha.7");
  });

  it("prefers newer beta and alpha releases over the stable fallback", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const selected = selectChannelReleases([
      githubRelease("v1.1.0"),
      githubRelease("v1.3.0-alpha.1", { prerelease: true }),
      githubRelease("v1.2.0-beta.1", { prerelease: true })
    ]);
    expect(selected.betaLatest?.tag_name).toBe("v1.2.0-beta.1");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.3.0-alpha.1");
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
  });

  it("leaves unavailable slots empty when there is no stable fallback", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    expect(selectChannelReleases([]).betaPrerelease).toBeUndefined();
    const selected = selectChannelReleases([
      githubRelease("v1.2.0-alpha.1", { prerelease: true })
    ]);
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease?.tag_name).toBe("v1.2.0-alpha.1");
  });

  it("ignores drafts in both channels", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v2.0.0", prerelease: false, draft: true },
      { tag_name: "v1.5.0", prerelease: false, draft: false },
      { tag_name: "v1.6.0-rc.1", prerelease: true, draft: true },
      { tag_name: "v1.5.1-rc.1", prerelease: true, draft: false }
    ];
    const { latest, prerelease } = selectChannelReleases(releases);
    expect(latest?.tag_name).toBe("v1.5.0");
    expect(prerelease?.tag_name).toBe("v1.5.1-rc.1");
  });
});

describe("selectAppUpdateReleases", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform
    });
  });

  it.each(["darwin", "win32"] as const)("uses only eligible promotion assets on %s", async (platform) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    const { selectAppUpdateReleases } = await import("./auto-updater");
    const assets = platform === "darwin" ? macUpdateAssets("1.1.0") : [
      { name: "latest.yml", state: "uploaded" },
      { name: "PwrGit-1.1.0-setup.exe", state: "uploaded" }
    ];
    const otherPlatformAssets = platform === "win32" ? macUpdateAssets("1.1.0") : [
      { name: "latest.yml", state: "uploaded" },
      { name: "PwrGit-1.1.0-setup.exe", state: "uploaded" }
    ];
    for (const incomplete of [[], [assets[0]], [assets[1]], otherPlatformAssets,
      [assets[0], { ...assets[1], state: "deleted" }]]) {
      const selected = selectAppUpdateReleases([githubRelease("v1.1.0", { assets: incomplete })]);
      expect(selected.betaLatest).toBeUndefined();
      expect(selected.betaPrerelease).toBeUndefined();
    }
    const final = githubRelease("v1.1.0", { assets });
    const selected = selectAppUpdateReleases([
      githubRelease("v1.2.0-beta.1", { prerelease: true, assets: [] }),
      githubRelease("v1.3.0-alpha.1", { prerelease: true, assets: [] }),
      githubRelease("v2.0.0", { draft: true, assets }),
      final
    ]);
    expect(selected.betaLatest).toBe(final);
    expect(selected.betaPrerelease).toBe(final);
  });

  it("requires macOS updater metadata and zip assets", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin"
    });
    const { selectAppUpdateReleases } = await import("./auto-updater");
    const releases = [
      githubRelease("v1.0.0-beta.39", {
        assets: [
          { name: "latest-mac.yml", state: "uploaded" },
          { name: "PwrGit-1.0.0-beta.39-arm64-mac.zip", state: "uploaded" }
        ]
      }),
      githubRelease("v1.0.0-beta.38", {
        assets: [
          { name: "latest-mac.yml", state: "uploaded" },
          { name: "PwrGit-1.0.0-beta.37-universal-mac.zip", state: "uploaded" }
        ]
      }),
      githubRelease("v1.0.0-beta.37", { assets: [] }),
      githubRelease("v1.0.0-beta.36", {
        assets: [{ name: "latest-mac.yml", state: "uploaded" }]
      }),
      githubRelease("v1.0.0-beta.35")
    ];

    const { latest, prerelease } = selectAppUpdateReleases(releases);

    expect(latest?.tag_name).toBe("v1.0.0-beta.35");
    expect(prerelease?.tag_name).toBe("v1.0.0-beta.35");
  });
});
