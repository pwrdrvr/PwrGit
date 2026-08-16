import { app } from "electron";
// electron-updater is CommonJS; import the default and destructure so the
// strict-ESM main bundle can load it (named ESM imports fail at runtime).
import electronUpdater from "electron-updater";
import {
  ok,
  type AppUpdateCheckResult,
  type AppUpdateInstallResult,
  type AppUpdateReleaseInfo,
  type AppUpdateReleaseVersions,
  type AppUpdateStatus,
  type UpdateChannel,
  type UpdatesSettings,
  type UpdateTrain
} from "@pwrgit/shared";
import type { CommandBus } from "./command-bus";
import { emitEvent } from "./ipc";
import { logMain } from "./logs";

const { autoUpdater } = electronUpdater;

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/pwrdrvr/PwrGit/releases?per_page=30";
const RELEASE_FETCH_TIMEOUT_MS = 5_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

const MAC_UPDATE_CHANNEL_FILE = "latest-mac.yml";
const WINDOWS_UPDATE_CHANNEL_FILE = "latest.yml";

type UpdateSelectionKey = `${UpdateTrain}:${UpdateChannel}`;

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
};

type GitHubReleaseAsset = {
  name?: string;
  state?: string;
};

type ParsedSemver = {
  core: [number, number, number];
  pre: Array<string | number>;
};

type AutoUpdaterOptions = {
  resolveSelection: () => UpdatesSettings;
};

let initialized = false;
let resolveSelection: () => UpdatesSettings = () => ({
  train: "stable",
  channel: "latest"
});
let updateStatus: AppUpdateStatus = { status: "idle" };
let periodicUpdateCheckTimer: ReturnType<typeof setInterval> | undefined;
let updateCheckInFlight: Promise<AppUpdateCheckResult> | undefined;
let updateCheckChannelInFlight: UpdateSelectionKey | undefined;
let heldDownloadedUpdate:
  | { selection: UpdateSelectionKey; version: string }
  | undefined;
const pendingDownloadChannelsByVersion = new Map<string, UpdateSelectionKey>();

function currentSelection(): UpdatesSettings {
  try {
    return resolveSelection();
  } catch (err) {
    logMain(
      "warn",
      "updater",
      "failed to read update selection",
      err instanceof Error ? err.message : String(err)
    );
    return { train: "stable", channel: "latest" };
  }
}

function updateSelectionKey(
  train: UpdateTrain,
  channel: UpdateChannel
): UpdateSelectionKey {
  return `${train}:${channel}`;
}

function currentUpdateSelectionKey(): UpdateSelectionKey {
  const selected = currentSelection();
  return updateSelectionKey(selected.train, selected.channel);
}

function setUpdateStatus(nextStatus: AppUpdateStatus): void {
  updateStatus = nextStatus;
  emitEvent("app:updateStatus", nextStatus);
}

export function readAppUpdateStatus(): AppUpdateStatus {
  reconcileDownloadedUpdateEligibility();
  return updateStatus;
}

function configureAutoUpdaterChannel(
  selected: UpdatesSettings = currentSelection()
): void {
  autoUpdater.allowPrerelease =
    selected.train === "beta" || selected.channel === "prerelease";
  logMain(
    "info",
    "updater",
    `configured channel train=${selected.train} track=${selected.channel} allowPrerelease=${autoUpdater.allowPrerelease}`
  );
}

function configureAutoUpdaterFeedForRelease(release: GitHubRelease): void {
  const tag = release.tag_name;
  if (!tag) return;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `https://github.com/pwrdrvr/PwrGit/releases/download/${encodeURIComponent(tag)}/`
  });
  logMain("info", "updater", `pinned feed to ${tag}`);
}

function productionUpdatesEnabled(): boolean {
  return app.isPackaged;
}

function developmentUpdateCheckResult(): AppUpdateCheckResult {
  return {
    status: "skipped",
    reason: "auto-update disabled in development"
  };
}

function linuxManualPackageUpdateCheckResult(): AppUpdateCheckResult {
  return {
    status: "skipped",
    reason: "Linux builds are updated by installing a newer package."
  };
}

function linuxManualPackageUpdatesEnabled(): boolean {
  return process.platform === "linux";
}

function preserveDownloadedStatus(nextStatus: AppUpdateStatus): boolean {
  if (updateStatus.status !== "downloaded") return false;
  return (
    nextStatus.status === "checking" ||
    nextStatus.status === "no-update" ||
    nextStatus.status === "error"
  );
}

function downloadedUpdateMatchesChannel(
  selection: UpdateSelectionKey
): Extract<AppUpdateCheckResult, { status: "downloaded" }> | undefined {
  if (heldDownloadedUpdate?.selection !== selection) return undefined;
  return { status: "downloaded", version: heldDownloadedUpdate.version };
}

function syncAutoInstallOnAppQuit(selection: UpdateSelectionKey): void {
  autoUpdater.autoInstallOnAppQuit =
    downloadedUpdateMatchesChannel(selection) !== undefined ||
    heldDownloadedUpdate === undefined;
}

export function reconcileDownloadedUpdateEligibility(
  selection: UpdateSelectionKey = currentUpdateSelectionKey()
): void {
  const eligibleDownload = downloadedUpdateMatchesChannel(selection);
  syncAutoInstallOnAppQuit(selection);
  if (eligibleDownload) {
    if (
      updateStatus.status !== "downloaded" ||
      updateStatus.version !== eligibleDownload.version
    ) {
      setUpdateStatus(eligibleDownload);
    }
    return;
  }
  if (updateStatus.status === "downloaded") {
    const currentVersion = autoUpdater.currentVersion?.version ?? "unknown";
    logMain(
      "info",
      "updater",
      `hiding downloaded update from unselected train held=${heldDownloadedUpdate?.selection} selected=${selection}`
    );
    setUpdateStatus({ status: "no-update", version: currentVersion });
  }
}

function setUpdateStatusUnlessDownloaded(nextStatus: AppUpdateStatus): void {
  const eligibleDownload = downloadedUpdateMatchesChannel(
    currentUpdateSelectionKey()
  );
  if (eligibleDownload && preserveDownloadedStatus(nextStatus)) {
    return;
  }
  setUpdateStatus(nextStatus);
}

function recordPendingDownloadChannel(
  version: string | undefined,
  selection: UpdateSelectionKey | undefined
): void {
  if (!version || !selection) return;
  pendingDownloadChannelsByVersion.set(version, selection);
}

export async function checkForAppUpdatesNow(
  trigger: "startup" | "periodic" | "manual" = "manual"
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) {
    const result = developmentUpdateCheckResult();
    setUpdateStatus(result);
    return result;
  }

  if (linuxManualPackageUpdatesEnabled()) {
    const result = linuxManualPackageUpdateCheckResult();
    setUpdateStatus(result);
    return result;
  }

  if (updateCheckInFlight) {
    logMain("info", "updater", `joining in-flight update check (${trigger})`);
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async () => {
    try {
      const selected = currentSelection();
      const selection = updateSelectionKey(selected.train, selected.channel);
      reconcileDownloadedUpdateEligibility(selection);
      const downloadedResult = downloadedUpdateMatchesChannel(selection);
      if (downloadedResult) {
        logMain(
          "info",
          "updater",
          `skipping check; update already downloaded ${downloadedResult.version}`
        );
        return downloadedResult;
      }
      logMain(
        "info",
        "updater",
        `checking for updates (${trigger}) train=${selected.train} track=${selected.channel}`
      );
      configureAutoUpdaterChannel(selected);
      const release = await readAppUpdateReleaseForChannel(
        selected.channel,
        selected.train
      );
      const currentVersion = autoUpdater.currentVersion?.version ?? "unknown";
      if (!release?.tag_name) {
        const result = { status: "no-update", version: currentVersion } as const;
        setUpdateStatusUnlessDownloaded(result);
        return result;
      }
      const selectedVersion = release.tag_name.replace(/^v/i, "");
      if (compareSemver(selectedVersion, currentVersion) <= 0) {
        const result = { status: "no-update", version: currentVersion } as const;
        setUpdateStatusUnlessDownloaded(result);
        return result;
      }
      configureAutoUpdaterFeedForRelease(release);
      updateCheckChannelInFlight = selection;
      const result = await autoUpdater.checkForUpdates();
      if (result?.updateInfo?.version !== currentVersion) {
        recordPendingDownloadChannel(
          result?.updateInfo?.version,
          selection
        );
      }
      const matchingDownloadedResult = downloadedUpdateMatchesChannel(selection);
      if (matchingDownloadedResult) return matchingDownloadedResult;
      if (!result || !result.updateInfo) {
        return {
          status: "no-update",
          version: result?.updateInfo?.version ?? "unknown"
        };
      }
      if (result.updateInfo.version === currentVersion) {
        return { status: "no-update", version: currentVersion };
      }
      return { status: "available", version: result.updateInfo.version };
    } catch (err) {
      const result = {
        status: "error",
        message: err instanceof Error ? err.message : String(err)
      } as const;
      setUpdateStatusUnlessDownloaded(result);
      logMain("warn", "updater", "checkForUpdates failed", result.message);
      return result;
    } finally {
      updateCheckChannelInFlight = undefined;
      updateCheckInFlight = undefined;
    }
  })();

  return updateCheckInFlight;
}

function startPeriodicUpdateChecks(): void {
  if (periodicUpdateCheckTimer) return;
  periodicUpdateCheckTimer = setInterval(() => {
    void checkForAppUpdatesNow("periodic");
  }, APP_UPDATE_CHECK_INTERVAL_MS);
  periodicUpdateCheckTimer.unref?.();
}

function releaseInfoFromGitHubRelease(
  release: GitHubRelease | undefined,
  unavailableReason: string
): AppUpdateReleaseInfo {
  if (!release?.tag_name) {
    return { unavailableReason };
  }
  return {
    version: release.tag_name,
    ...(release.name ? { name: release.name } : {}),
    ...(release.html_url ? { url: release.html_url } : {}),
    ...(release.published_at ? { publishedAt: release.published_at } : {})
  };
}

function parseSemver(tag: string | undefined): ParsedSemver | undefined {
  if (!tag) return undefined;
  const trimmed = tag.trim().replace(/^v/i, "");
  const match = trimmed.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return undefined;
  const [, maj, min, patch, pre] = match;
  return {
    core: [Number(maj), Number(min), Number(patch)],
    pre: pre
      ? pre.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : []
  };
}

// Semver 2.0.0 precedence. Returns positive if a > b, negative if a < b.
// Unparseable tags sort below any valid version so they cannot win a "highest"
// selection over a real release.
export function compareSemver(a: string | undefined, b: string | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (typeof ai === "number" && typeof bi === "number") {
      if (ai !== bi) return ai - bi;
    } else if (typeof ai === "number") {
      return -1;
    } else if (typeof bi === "number") {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

function compareSemverCore(
  a: [number, number, number],
  b: [number, number, number]
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function firstPrereleaseId(tag: string | undefined): string | undefined {
  const parsed = parseSemver(tag);
  if (!parsed || parsed.pre.length === 0) return undefined;
  return typeof parsed.pre[0] === "string" ? parsed.pre[0] : undefined;
}

function isBetaTrainIdentifier(tag: string | undefined): boolean {
  const id = firstPrereleaseId(tag);
  return id === "alpha" || id === "beta";
}

// Beta slots must never advertise a downgrade from Stable Latest. Historical
// `v1.0.0-beta.N` tags, leftover `v1.1.0-beta.N` after `v1.1.0` is promoted,
// and same-core alphas all lose to the current Latest and stay off the Beta
// train. If there is not yet a GitHub Latest, only an alpha (or a beta that
// has a same-core alpha) counts — a lone `-beta.N` line is the old 1.0 train.
function isBetaTrainRelease(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined,
  releases: GitHubRelease[]
): boolean {
  if (release.prerelease !== true || !isBetaTrainIdentifier(release.tag_name)) {
    return false;
  }
  if (stableLatest) {
    const releaseParsed = parseSemver(release.tag_name);
    const stableParsed = parseSemver(stableLatest.tag_name);
    return (
      releaseParsed !== undefined &&
      stableParsed !== undefined &&
      compareSemverCore(releaseParsed.core, stableParsed.core) > 0
    );
  }
  if (firstPrereleaseId(release.tag_name) === "alpha") {
    return true;
  }
  const parsed = parseSemver(release.tag_name);
  if (!parsed) return false;
  return releases.some((candidate) => {
    if (candidate.draft === true || candidate.prerelease !== true) {
      return false;
    }
    const other = parseSemver(candidate.tag_name);
    return (
      other !== undefined &&
      compareSemverCore(other.core, parsed.core) === 0 &&
      other.pre[0] === "alpha"
    );
  });
}

function isBetaLatestRelease(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined,
  releases: GitHubRelease[]
): boolean {
  return (
    firstPrereleaseId(release.tag_name) === "beta" &&
    isBetaTrainRelease(release, stableLatest, releases)
  );
}

export type SelectedUpdateReleases = {
  latest: GitHubRelease | undefined;
  prerelease: GitHubRelease | undefined;
  stableLatest: GitHubRelease | undefined;
  stablePrerelease: GitHubRelease | undefined;
  betaLatest: GitHubRelease | undefined;
  betaPrerelease: GitHubRelease | undefined;
};

// Resolve slots by semver identifier and GitHub Latest, not publish order:
//   - stable latest      → highest GitHub non-prerelease (the 1.0 / normie feed)
//   - stable prerelease  → max(stable latest, 1.0 `-prerelease` / legacy `-beta`)
//   - beta latest        → highest `-beta` whose core is ahead of Stable Latest
//   - beta prerelease    → max(beta latest, highest `-alpha` on a newer core)
// Empty Beta slots stay empty. The Settings Beta control remains selectable
// so an operator can follow the next `main` tag after a Stable promotion.
export function selectChannelReleases(
  releases: GitHubRelease[]
): SelectedUpdateReleases {
  const publicReleases = releases.filter((release) => release.draft !== true);
  const byPrecedenceDesc = [...publicReleases].sort((a, b) =>
    compareSemver(b.tag_name, a.tag_name)
  );
  const stableLatest = byPrecedenceDesc.find(
    (release) => release.prerelease !== true
  );
  const betaLatest = byPrecedenceDesc.find((release) =>
    isBetaLatestRelease(release, stableLatest, publicReleases)
  );
  const stablePrerelease = byPrecedenceDesc.find((release) => {
    if (release === stableLatest) return true;
    if (release.prerelease !== true) return false;
    if (firstPrereleaseId(release.tag_name) === "alpha") return false;
    return !isBetaLatestRelease(release, stableLatest, publicReleases);
  });
  const betaPrerelease = byPrecedenceDesc.find((release) =>
    isBetaTrainRelease(release, stableLatest, publicReleases)
  );
  return {
    latest: stableLatest,
    prerelease: stablePrerelease,
    stableLatest,
    stablePrerelease,
    betaLatest,
    betaPrerelease
  };
}

function hasUploadedReleaseAsset(
  release: GitHubRelease,
  predicate: (assetName: string) => boolean
): boolean {
  return (
    release.assets?.some((asset) => {
      if (!asset.name || asset.state === "deleted") return false;
      return predicate(asset.name);
    }) ?? false
  );
}

function hasMacUpdateAssets(release: GitHubRelease): boolean {
  const hasChannelFile = hasUploadedReleaseAsset(
    release,
    (name) => name === MAC_UPDATE_CHANNEL_FILE
  );
  const hasZip = hasUploadedReleaseAsset(release, (name) =>
    name.endsWith(".zip")
  );
  return hasChannelFile && hasZip;
}

function hasWindowsUpdateAssets(release: GitHubRelease): boolean {
  const hasChannelFile = hasUploadedReleaseAsset(
    release,
    (name) => name === WINDOWS_UPDATE_CHANNEL_FILE
  );
  const hasInstaller = hasUploadedReleaseAsset(
    release,
    (name) => name.endsWith("-setup.exe") || name.endsWith(".exe")
  );
  return hasChannelFile && hasInstaller;
}

function hasPublishedUpdateAssets(release: GitHubRelease): boolean {
  return hasMacUpdateAssets(release) || hasWindowsUpdateAssets(release);
}

function hasCurrentPlatformUpdateAssets(release: GitHubRelease): boolean {
  if (process.platform === "darwin") return hasMacUpdateAssets(release);
  if (process.platform === "win32") return hasWindowsUpdateAssets(release);
  return false;
}

export function selectAppUpdateReleases(
  releases: GitHubRelease[]
): SelectedUpdateReleases {
  return selectChannelReleases(releases.filter(hasCurrentPlatformUpdateAssets));
}

function selectPublishedUpdateReleases(
  releases: GitHubRelease[]
): SelectedUpdateReleases {
  return selectChannelReleases(releases.filter(hasPublishedUpdateAssets));
}

function releaseForSelection(
  selected: SelectedUpdateReleases,
  channel: UpdateChannel,
  train: UpdateTrain
): GitHubRelease | undefined {
  if (train === "beta") {
    return channel === "prerelease"
      ? selected.betaPrerelease
      : selected.betaLatest;
  }
  return channel === "prerelease"
    ? selected.stablePrerelease
    : selected.stableLatest;
}

function githubReleaseHeaders(): HeadersInit {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "PwrGit",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function fetchGitHubReleases(signal?: AbortSignal): Promise<GitHubRelease[]> {
  const response = await fetch(GITHUB_RELEASES_URL, {
    headers: githubReleaseHeaders(),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload)
    ? payload.filter(
        (release): release is GitHubRelease =>
          typeof release === "object" && release !== null
      )
    : [];
}

async function readAppUpdateReleaseForChannel(
  channel: UpdateChannel,
  train: UpdateTrain
): Promise<GitHubRelease | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const releases = await fetchGitHubReleases(controller.signal);
    return releaseForSelection(
      selectAppUpdateReleases(releases),
      channel,
      train
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function readAppUpdateReleaseVersions(): Promise<AppUpdateReleaseVersions> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const releases = await fetchGitHubReleases(controller.signal);
    const selected = selectPublishedUpdateReleases(releases);
    return {
      fetchedAt: Date.now(),
      stable: {
        latest: releaseInfoFromGitHubRelease(
          selected.stableLatest,
          "No stable release found."
        ),
        prerelease: releaseInfoFromGitHubRelease(
          selected.stablePrerelease,
          "No stable prerelease found."
        )
      },
      beta: {
        latest: releaseInfoFromGitHubRelease(
          selected.betaLatest,
          "No beta release found."
        ),
        prerelease: releaseInfoFromGitHubRelease(
          selected.betaPrerelease,
          "No beta prerelease found."
        )
      }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unavailable = { unavailableReason: message };
    return {
      fetchedAt: Date.now(),
      stable: { latest: unavailable, prerelease: unavailable },
      beta: { latest: unavailable, prerelease: unavailable }
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function initAutoUpdater(options: AutoUpdaterOptions): void {
  if (initialized) return;
  initialized = true;
  resolveSelection = options.resolveSelection;

  if (!productionUpdatesEnabled()) {
    logMain("info", "updater", "auto-update disabled in non-packaged builds");
    setUpdateStatus(developmentUpdateCheckResult());
    return;
  }

  if (linuxManualPackageUpdatesEnabled()) {
    logMain("info", "updater", "auto-update disabled for Linux package builds");
    setUpdateStatus(linuxManualPackageUpdateCheckResult());
    return;
  }

  autoUpdater.logger = {
    info: (...args: unknown[]) => logMain("info", "updater", ...args),
    warn: (...args: unknown[]) => logMain("warn", "updater", ...args),
    error: (...args: unknown[]) => logMain("error", "updater", ...args),
    debug: (...args: unknown[]) => logMain("debug", "updater", ...args)
  } as unknown as Console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  configureAutoUpdaterChannel();

  autoUpdater.on("checking-for-update", () => {
    logMain("info", "updater", "checking-for-update");
    setUpdateStatusUnlessDownloaded({ status: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    logMain("info", "updater", `update-available ${info.version}`);
    recordPendingDownloadChannel(info.version, updateCheckChannelInFlight);
    setUpdateStatus({ status: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => {
    logMain("info", "updater", `update-not-available ${info.version}`);
    setUpdateStatusUnlessDownloaded({
      status: "no-update",
      version: info.version
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    const version =
      updateStatus.status === "available" ||
      updateStatus.status === "downloading"
        ? updateStatus.version
        : "unknown";
    setUpdateStatus({
      status: "downloading",
      version,
      percent: Math.round(progress.percent)
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    logMain("info", "updater", `update-downloaded ${info.version}`);
    const selection = info.version
      ? (pendingDownloadChannelsByVersion.get(info.version) ??
        currentUpdateSelectionKey())
      : undefined;
    if (info.version) pendingDownloadChannelsByVersion.delete(info.version);
    if (info.version && selection) {
      heldDownloadedUpdate = { selection, version: info.version };
    }
    reconcileDownloadedUpdateEligibility();
  });
  autoUpdater.on("error", (err: Error) => {
    logMain("warn", "updater", "auto-update error", err.message);
    setUpdateStatusUnlessDownloaded({ status: "error", message: err.message });
  });

  startPeriodicUpdateChecks();
  void checkForAppUpdatesNow("startup");
}

export async function installDownloadedAppUpdate(): Promise<AppUpdateInstallResult> {
  const eligibleDownload = downloadedUpdateMatchesChannel(
    currentUpdateSelectionKey()
  );
  const version = eligibleDownload?.version;
  if (!version) {
    return {
      status: "error",
      message: heldDownloadedUpdate
        ? "The downloaded update is not for the selected channel."
        : "No downloaded update is ready to install."
    };
  }
  try {
    logMain("info", "updater", `installing downloaded update ${version}`);
    autoUpdater.quitAndInstall();
    return { status: "restarting" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

export function registerAppUpdateHandlers(bus: CommandBus): void {
  bus.register("app:readUpdateStatus", () => {
    reconcileDownloadedUpdateEligibility();
    return ok(updateStatus);
  });
  bus.register("app:readUpdateReleases", async () =>
    ok(await readAppUpdateReleaseVersions())
  );
  bus.register("app:checkForUpdate", async () =>
    ok(await checkForAppUpdatesNow("manual"))
  );
  bus.register("app:installUpdate", async () =>
    ok(await installDownloadedAppUpdate())
  );
}
