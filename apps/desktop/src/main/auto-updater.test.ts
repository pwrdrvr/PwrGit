import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UpdateEventHandler = (info?: {
  version?: string;
  percent?: number;
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
      await vi.advanceTimersByTimeAsync(2_000);
      return await pending;
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
      expect(
        emitEventMock.mock.calls
          .filter(([channel]) => channel === "app:updateStatus")
          .map(([, payload]) => (payload as { status: string }).status)
      ).toEqual(["checking", "available", "downloading", "downloaded"]);
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
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
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
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
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
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
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
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease?.tag_name).toBe("v1.2.0-alpha.1");
  });

  it("shows an alpha as beta prerelease before a beta exists", async () => {
    const { selectChannelReleases } = await import("./auto-updater");
    const releases = [
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false }
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-alpha.7");
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

  it("requires macOS updater metadata and zip assets", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin"
    });
    const { selectAppUpdateReleases } = await import("./auto-updater");
    const releases = [
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
