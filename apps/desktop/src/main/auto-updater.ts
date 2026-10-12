import { app, autoUpdater as electronNativeUpdater } from "electron";
import { join } from "node:path";
// electron-updater is CommonJS; import the default and destructure so the
// strict-ESM main bundle can load it (named ESM imports fail at runtime).
import electronUpdater from "electron-updater";
import {
  ok,
  type AppUpdateCancelResult,
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
import {
  linuxPackageFormat,
  linuxArtifactSuffix,
  linuxChannelFile,
  linuxManualUpdateInstructions
} from "./linux-updates";
import { delay } from "./util/timing";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  UpdateReleaseStateStore,
  parseGitHubReleases,
  type GitHubRelease
} from "./update-release-state";
export { APP_UPDATE_CHECK_INTERVAL_MS } from "./update-release-state";

const { autoUpdater } = electronUpdater;

/** Electron's own `autoUpdater` — on macOS, the Squirrel.Mac wrapper that
 *  electron-updater's MacUpdater drives. Read defensively: test suites mock
 *  `electron` with only the exports they use, and reading a missing export off
 *  a vitest mock throws. */
function optionalNativeUpdater():
  | Pick<NodeJS.EventEmitter, "once" | "removeListener">
  | undefined {
  try {
    return typeof electronNativeUpdater?.once === "function"
      ? electronNativeUpdater
      : undefined;
  } catch {
    return undefined;
  }
}

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/pwrdrvr/PwrGit/releases?per_page=30";
const RELEASE_FETCH_TIMEOUT_MS = 5_000;
// The GitHub REST API allows 60 anonymous requests per hour per IP, shared by
// every process on the machine. The renderer reads release versions on every
// Settings mount. Main persists the list and enforces an hourly automatic
// request budget even after this freshness window expires or the app restarts.
export const APP_UPDATE_RELEASE_CACHE_TTL_MS = 15 * 60 * 1_000;
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 15 * 60 * 1_000;
/** How long a superseding macOS download may wait for Squirrel.Mac to stage
 *  it before the older staged build is offered again. Squirrel re-fetches the
 *  whole zip from electron-updater's loopback proxy, unpacks it and checks its
 *  signature, so this is sized like a download rather than a request. */
const SQUIRREL_STAGE_TIMEOUT_MS = 5 * 60 * 1_000;

const MAC_UPDATE_CHANNEL_FILE = "latest-mac.yml";
const WINDOWS_UPDATE_CHANNEL_FILE = "latest.yml";

/** Unmistakably not-a-release version the dev/QA fake update reports (see
 *  `simulateDevUpdateCheck`), so a previewed toast can never be read as a
 *  genuine offer. */
const DEV_FAKE_UPDATE_VERSION = "420.0.0";
/** Long enough to watch each transition land, short enough not to feel hung. */
const DEV_FAKE_UPDATE_DEFAULT_STEP_MS = 300;

/** e2e seam, alongside `PWRGIT_USER_DATA_DIR` and `PWRGIT_GITCONFIG`. The
 *  Cancel button can only be exercised while the fake is mid-download, and at
 *  the dev pace that window is a couple of seconds — comfortable by hand, a
 *  race on a loaded CI runner. The spec widens it rather than asserting
 *  something weaker. Only ever read in an unpackaged build: the whole fake is
 *  behind `productionUpdatesEnabled()`. */
function devFakeUpdateStepMs(): number {
  const raw = Number(process.env["PWRGIT_E2E_UPDATE_STEP_MS"]);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEV_FAKE_UPDATE_DEFAULT_STEP_MS;
}
/** Percent ticks the fake download reports. Enough of them that the meter is
 *  visibly a meter and the Cancel button has a window to be pressed in. */
const DEV_FAKE_UPDATE_PERCENT_STEPS = [0, 15, 34, 58, 79, 93, 100];
/** A plausible universal-mac zip, so the byte line is exercised too. */
const DEV_FAKE_UPDATE_TOTAL_BYTES = 118_000_000;

type UpdateSelectionKey = `${UpdateTrain}:${UpdateChannel}`;
type AppUpdateCheckTrigger =
  | "startup"
  | "periodic"
  | "manual"
  | "menu"
  | "selection"
  | "settings";

type ParsedSemver = {
  core: [number, number, number];
  pre: Array<string | number>;
};

type AutoUpdaterOptions = {
  resolveSelection: () => UpdatesSettings;
  beforeQuitAndInstall?: () => Promise<void>;
};

let initialized = false;
let nativeLinuxInstallAccepted = false;
let beforeQuitAndInstall: (() => Promise<void>) | undefined;
let observedSelection: UpdateSelectionKey | undefined;
let resolveSelection: () => UpdatesSettings = () => ({
  train: "stable",
  channel: "latest"
});
let updateStatus: AppUpdateStatus = { status: "idle" };
let periodicUpdateCheckTimer: ReturnType<typeof setTimeout> | undefined;
let updateCheckInFlight: Promise<AppUpdateCheckResult> | undefined;
let updateCheckInFlightSelection: UpdateSelectionKey | undefined;
let updateCheckChannelInFlight: UpdateSelectionKey | undefined;
type HeldDownload = { selection: UpdateSelectionKey; version: string };
let heldDownloadedUpdate: HeldDownload | undefined;
/**
 * A newer release is downloading over an update that was already downloaded.
 *
 * A downloaded update used to end every later check, so someone who left the
 * app open across two releases restarted into the older one only to be
 * offered the newer one straight away. Now the check keeps reading the feed
 * and a newer release on the same track replaces the held one.
 *
 * What the replaced update is still good for differs by platform, and that is
 * why this is tracked at all:
 *
 * - macOS: Squirrel.Mac keeps the older build staged until the newer one is
 *   staged in its place, and MacUpdater's `squirrelDownloadedUpdate` never
 *   resets — so `quitAndInstall` installs the OLDER build until Electron's
 *   native `autoUpdater` emits its own `update-downloaded`.
 *   `heldDownloadedUpdate` stays on the older build until then (see
 *   `awaitSquirrelStage`), and a newer download that fails, is canceled, or
 *   never stages puts the older Restart offer back.
 * - Windows and Linux: starting the new download empties electron-updater's
 *   pending cache dir (`DownloadedUpdateHelper` sees a sha512 mismatch and
 *   calls `cleanCacheDirForPendingUpdate`), deleting the older installer
 *   while `downloadedUpdateHelper.file` still names it. The older offer is
 *   dropped when the download starts, install-on-quit is held off until the
 *   newer `update-downloaded`, and a failure does not bring the older back.
 */
let supersedingDownload: HeldDownload | undefined;
/** macOS only: electron-updater has the newer build and has asked Squirrel.Mac
 *  to stage it. Settles once Squirrel confirms, fails, or times out. */
let pendingSquirrelStage: Promise<void> | undefined;
const pendingDownloadChannelsByVersion = new Map<string, UpdateSelectionKey>();
/**
 * The download the user can still stop.
 *
 * Held rather than derived because `cancel` has to reach electron-updater's
 * own token, and because the rejection that token produces is
 * indistinguishable from a network failure unless we remember that we were
 * the ones who asked.
 *
 * Registered as soon as the status reaches `available` — NOT when the bytes
 * start moving. The toast offers Cancel from `available` onwards, so anything
 * later leaves a window in which the button is on screen and does nothing:
 * the click sets `canceling` in the renderer, finds no download here, and the
 * update installs anyway. `cancel` is therefore a mutable slot, filled in
 * once electron-updater hands over its token.
 */
type ActiveDownload = {
  version: string;
  cancel: () => void;
  /** Set by `cancelAppUpdateDownload`, read wherever the download can stop. */
  canceled: boolean;
};

let activeDownload: ActiveDownload | undefined;

/** Take the cancel a user asked for before there was anything to ask. Called
 *  wherever a download becomes stoppable, so a click that landed early is
 *  honoured instead of dropped. */
function applyPendingCancel(download: ActiveDownload): boolean {
  if (!download.canceled) return false;
  try {
    download.cancel();
  } catch (err) {
    logMain(
      "warn",
      "updater",
      "failed to apply a cancel requested before the download started",
      err instanceof Error ? err.message : String(err)
    );
  }
  return true;
}
let updateCheckReleaseTag: string | undefined;
let releaseFetchInFlight: Promise<GitHubRelease[]> | undefined;
let releaseStore: UpdateReleaseStateStore | undefined;

function getReleaseStore(): UpdateReleaseStateStore {
  return releaseStore ??= new UpdateReleaseStateStore(
    join(app.getPath("userData"), "update-release-state.json")
  );
}

class DeferredReleaseCheck extends Error {}

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
  nextStatus = withLinuxUpdateHelp(nextStatus);
  updateStatus = nextStatus;
  emitEvent("app:updateStatus", nextStatus);
}

export function readAppUpdateStatus(): AppUpdateStatus {
  reconcileDownloadedUpdateEligibility();
  return updateStatus;
}

/** Called after settings writes; unrelated preferences must not start checks. */
export function handleUpdateSelectionChange(): void {
  const selection = currentUpdateSelectionKey();
  reconcileDownloadedUpdateEligibility(selection);
  if (selection === observedSelection) return;
  observedSelection = selection;
  if (initialized && productionUpdatesEnabled()) {
    runBackgroundUpdateCheck("selection");
  }
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

function githubUpdateToken(): string | undefined {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return token || undefined;
}

function configureAutoUpdaterFeedForRelease(release: GitHubRelease): void {
  const tag = release.tag_name;
  if (!tag) return;
  // Pin to the selected tag via a generic feed. setFeedURL does not copy
  // requestHeaders onto the updater, so auth is applied afterward — the same
  // GH_TOKEN / GITHUB_TOKEN PrivateGitHubProvider would have used.
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `https://github.com/pwrdrvr/PwrGit/releases/download/${encodeURIComponent(tag)}/`
  });
  const token = githubUpdateToken();
  if (token) {
    autoUpdater.addAuthHeader(`token ${token}`);
  } else {
    logMain(
      "warn",
      "updater",
      "no GH_TOKEN/GITHUB_TOKEN; private release downloads will 404"
    );
  }
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
  return withLinuxUpdateHelp({
    status: "skipped" as const,
    reason: "This Linux build requires a manual update."
  });
}

function linuxManualPackageUpdatesEnabled(): boolean {
  return process.platform === "linux" && linuxPackageFormat() === undefined;
}

function withLinuxUpdateHelp<T extends AppUpdateCheckResult | AppUpdateStatus | AppUpdateInstallResult>(
  result: T,
  tag?: string
): T {
  if (result.status !== "error" && result.status !== "skipped") return result;
  const manualUpdate = linuxManualUpdateInstructions(tag);
  return manualUpdate ? { manualUpdate, ...result } : result;
}

function preserveDownloadedStatus(nextStatus: AppUpdateStatus): boolean {
  if (updateStatus.status !== "downloaded") return false;
  return (
    nextStatus.status === "checking" ||
    nextStatus.status === "no-update" ||
    nextStatus.status === "canceled" ||
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
  // Windows/Linux: the replaced installer is already gone from the pending
  // cache, but electron-updater still points at it, so quitting must not try
  // to run it. macOS keeps the usual rule — MacUpdater reads this when the
  // newer download lands, and it is what makes Squirrel stage that build.
  if (supersedingDownload !== undefined && process.platform !== "darwin") {
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }
  autoUpdater.autoInstallOnAppQuit =
    process.platform !== "linux" && (
      downloadedUpdateMatchesChannel(selection) !== undefined ||
      heldDownloadedUpdate === undefined
    );
}

export function reconcileDownloadedUpdateEligibility(
  selection: UpdateSelectionKey = currentUpdateSelectionKey()
): void {
  const eligibleDownload = downloadedUpdateMatchesChannel(selection);
  syncAutoInstallOnAppQuit(selection);
  // The status is reporting the newer download. Every status read and
  // settings write reconciles, so without this a Settings mount would put the
  // older Restart offer back over the progress the user is watching.
  if (supersedingDownload !== undefined) return;
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

/** Start downloading a newer release over `replaced`. */
function beginSupersede(replaced: HeldDownload): void {
  supersedingDownload = replaced;
  syncAutoInstallOnAppQuit(replaced.selection);
}

/** The newer release did not arrive — no download started, it failed or was
 *  canceled, or Squirrel.Mac never staged it. On macOS the older staged build
 *  is still installable and its Restart offer comes back; elsewhere it was
 *  dropped when the download started. */
function abandonSupersede(reason: string): void {
  if (supersedingDownload === undefined) return;
  const replaced = supersedingDownload;
  supersedingDownload = undefined;
  logMain(
    "info",
    "updater",
    `newer update did not replace downloaded ${replaced.version} (${reason}); ` +
      `still installable=${heldDownloadedUpdate !== undefined}`
  );
  reconcileDownloadedUpdateEligibility();
}

/** The newer build is ready to install: make it the Restart offer. */
function promoteSupersede(next: HeldDownload): void {
  heldDownloadedUpdate = next;
  supersedingDownload = undefined;
  reconcileDownloadedUpdateEligibility();
}

/**
 * macOS: offer the newer build only once Squirrel.Mac has staged it.
 *
 * electron-updater emits `update-downloaded` as soon as the zip is on disk,
 * BEFORE Squirrel fetches it from the loopback proxy, and its
 * `squirrelDownloadedUpdate` flag is still true from the build being
 * replaced. A Restart clicked in that gap would install the OLDER build while
 * the UI named the newer one. Electron's native `update-downloaded` is the
 * signal that `quitAndInstall` now means the newer build.
 */
function awaitSquirrelStage(next: HeldDownload): Promise<void> {
  const native = optionalNativeUpdater();
  if (native === undefined) {
    logMain(
      "warn",
      "updater",
      `cannot observe Squirrel.Mac staging; offering ${next.version} now`
    );
    promoteSupersede(next);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (staged: boolean, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      native.removeListener("update-downloaded", onStaged);
      native.removeListener("error", onFailed);
      if (staged) {
        logMain("info", "updater", `Squirrel.Mac staged ${next.version}`);
        promoteSupersede(next);
      } else {
        abandonSupersede(reason);
      }
      resolve();
    };
    const onStaged = (): void => settle(true, "staged");
    const onFailed = (err?: unknown): void =>
      settle(
        false,
        `Squirrel.Mac failed to stage ${next.version}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    native.once("update-downloaded", onStaged);
    native.once("error", onFailed);
    const timer = setTimeout(
      () => settle(false, `timed out waiting for Squirrel.Mac to stage ${next.version}`),
      SQUIRREL_STAGE_TIMEOUT_MS
    );
    timer.unref?.();
  });
}

function recordPendingDownloadChannel(
  version: string | undefined,
  selection: UpdateSelectionKey | undefined
): void {
  if (!version || !selection) return;
  pendingDownloadChannelsByVersion.set(version, selection);
}

export async function checkForAppUpdatesNow(
  trigger: AppUpdateCheckTrigger = "manual"
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) return simulateDevUpdateCheck(trigger);

  if (linuxManualPackageUpdatesEnabled()) {
    const result = linuxManualPackageUpdateCheckResult();
    setUpdateStatus(result);
    return result;
  }

  const wanted = currentUpdateSelectionKey();
  if (updateCheckInFlight) {
    if (wanted === updateCheckInFlightSelection) {
      logMain("info", "updater", `joining in-flight update check (${trigger})`);
      const result = await updateCheckInFlight;
      // An explicit click racing the initial deferred check must still work.
      if (
        result.status === "skipped" &&
        (trigger === "manual" || trigger === "menu")
      ) {
        return checkForAppUpdatesNow(trigger);
      }
      return result;
    }
    logMain(
      "info",
      "updater",
      `deferring ${wanted} check until ${updateCheckInFlightSelection} finishes (${trigger})`
    );
    try {
      await updateCheckInFlight;
    } catch {
      // The in-flight check already reported its error.
    }
    return checkForAppUpdatesNow(trigger);
  }

  const check = (async () => {
    try {
      updateCheckReleaseTag = undefined;
      return await runUpdateCheck(trigger);
    } catch (error) {
      if (error instanceof DeferredReleaseCheck || process.platform !== "linux") throw error;
      const result = withLinuxUpdateHelp({
        status: "error" as const,
        message: error instanceof Error ? error.message : String(error)
      }, updateCheckReleaseTag);
      setUpdateStatusUnlessDownloaded(result);
      return result;
    } finally {
      updateCheckChannelInFlight = undefined;
      updateCheckInFlight = undefined;
      updateCheckInFlightSelection = undefined;
    }
  })();
  updateCheckInFlight = check;
  updateCheckInFlightSelection = wanted;
  return check;
}

async function runUpdateCheck(
  trigger: AppUpdateCheckTrigger
): Promise<AppUpdateCheckResult> {
  const selected = currentSelection();
  const selection = updateSelectionKey(selected.train, selected.channel);
  reconcileDownloadedUpdateEligibility(selection);
  // A downloaded update no longer ends the check. A newer release on the same
  // track replaces it, so the Restart offer names the newest build instead of
  // one the user restarts into only to be offered another straight away.
  const downloadedResult = downloadedUpdateMatchesChannel(selection);
  if (!downloadedResult) {
    return await runReleaseCheck(trigger, selected, selection, undefined);
  }
  try {
    return await runReleaseCheck(trigger, selected, selection, downloadedResult);
  } catch (err) {
    // A failed look for something newer does not undo the download we have.
    // On Windows/Linux a download that started has already dropped it, and
    // then the failure is the answer.
    const held = downloadedUpdateMatchesChannel(selection);
    if (!held) throw err;
    logMain(
      "warn",
      "updater",
      `keeping downloaded update ${held.version}; check for a newer release failed`,
      err instanceof Error ? err.message : String(err)
    );
    return held;
  }
}

async function runReleaseCheck(
  trigger: AppUpdateCheckTrigger,
  selected: UpdatesSettings,
  selection: UpdateSelectionKey,
  downloadedResult: Extract<AppUpdateCheckResult, { status: "downloaded" }> | undefined
): Promise<AppUpdateCheckResult> {
  const store = getReleaseStore();
  const manual = trigger === "manual" || trigger === "menu";
  if (!manual && Date.now() < store.automaticCheckAt()) {
    // Still `skipped` with a download held: a click that joined this check
    // re-runs only on that answer, and must read the feed for itself.
    return {
      status: "skipped",
      reason: "Automatic update check deferred; use Check for Update to check now."
    };
  }
  // Reserve the whole check before network work, including metadata/download
  // requests through electron-updater. Restarting cannot replay a cached offer.
  store.state.lastCheckAt = Date.now();
  store.save();
  logMain(
    "info",
    "updater",
    `checking for updates (${trigger}) train=${selected.train} track=${selected.channel}` +
      (downloadedResult ? ` downloaded=${downloadedResult.version}` : "")
  );
  configureAutoUpdaterChannel(selected);
  // Explicit checks revalidate immediately. A 304 saves primary quota only
  // when authenticated; anonymous conditional requests still need a budget.
  const release = await readAppUpdateReleaseForChannel(
    selected.channel,
    selected.train,
    manual ? 0 : undefined
  );
  const currentVersion = autoUpdater.currentVersion?.version ?? "unknown";
  if (!release?.tag_name) {
    if (downloadedResult) return downloadedResult;
    const result = { status: "no-update", version: currentVersion } as const;
    setUpdateStatusUnlessDownloaded(result);
    return result;
  }
  const selectedVersion = release.tag_name.replace(/^v/i, "");
  if (downloadedResult) {
    // `compareSemver` sorts an unparseable version below everything. An
    // unreadable tag keeps the update we already have, and so does an
    // unreadable held version — or every check would download again.
    if (
      parseSemver(downloadedResult.version) === undefined ||
      compareSemver(selectedVersion, downloadedResult.version) <= 0
    ) {
      logMain(
        "info",
        "updater",
        `keeping downloaded update ${downloadedResult.version}; selected ${release.tag_name} is not newer`
      );
      return downloadedResult;
    }
    logMain(
      "info",
      "updater",
      `replacing downloaded update ${downloadedResult.version} with ${release.tag_name}`
    );
  }
  if (compareSemver(selectedVersion, currentVersion) <= 0) {
    const result = { status: "no-update", version: currentVersion } as const;
    setUpdateStatusUnlessDownloaded(result);
    return result;
  }
  updateCheckReleaseTag = release.tag_name;
  configureAutoUpdaterFeedForRelease(release);
  updateCheckChannelInFlight = selection;
  // Registered before the call, not after it: `checkForUpdates` emits
  // `update-available` — the status that puts Cancel on screen — from inside
  // itself, and with `autoDownload` on it has already started fetching by the
  // time it resolves.
  const download: ActiveDownload = {
    version: selectedVersion,
    cancel: () => {},
    canceled: false
  };
  if (downloadedResult && heldDownloadedUpdate) beginSupersede(heldDownloadedUpdate);
  activeDownload = download;
  try {
    return await runAvailableUpdateDownload(download, selection, currentVersion);
  } catch (err) {
    abandonSupersede("update check failed");
    throw err;
  } finally {
    if (activeDownload === download) activeDownload = undefined;
  }
}

/** The half of a check that can be cancelled, split out so one `finally` can
 *  own `activeDownload` for its whole life. */
async function runAvailableUpdateDownload(
  download: ActiveDownload,
  selection: UpdateSelectionKey,
  currentVersion: string
): Promise<AppUpdateCheckResult> {
  const result = await autoUpdater.checkForUpdates();
  if (result?.isUpdateAvailable && result.updateInfo?.version) {
    recordPendingDownloadChannel(result.updateInfo.version, selection);
  }
  if (result?.isUpdateAvailable && result.downloadPromise) {
    if (supersedingDownload !== undefined && process.platform !== "darwin") {
      // Starting this download emptied electron-updater's pending cache dir,
      // and the replaced installer with it. Do not offer what is gone.
      heldDownloadedUpdate = undefined;
    }
    const downloadingVersion = result.updateInfo?.version ?? download.version;
    download.version = downloadingVersion;
    const token = result.cancellationToken;
    download.cancel = () => token?.cancel();
    // A cancel that arrived while the token did not yet exist: honour it now
    // rather than letting the download it asked to stop run to completion.
    applyPendingCancel(download);
    try {
      await result.downloadPromise;
    } catch (err) {
      // Before the status below: on macOS this puts the older Restart offer
      // back, and the canceled/error status then leaves it standing.
      abandonSupersede(download.canceled ? "download canceled" : "download failed");
      // A cancel rejects this promise exactly like a failed request would, and
      // electron-updater deliberately does NOT dispatch its `error` event for
      // one. Only our own flag separates "the user stopped it" from "the
      // download broke", and dressing the first as a failure would put a red
      // toast and an Open Logs button in front of someone who got what they
      // asked for.
      if (download.canceled) {
        const canceled = {
          status: "canceled",
          version: downloadingVersion
        } as const;
        setUpdateStatusUnlessDownloaded(canceled);
        logMain("info", "updater", `update download canceled ${downloadingVersion}`);
        return downloadedUpdateMatchesChannel(selection) ?? canceled;
      }
      const message = err instanceof Error ? err.message : String(err);
      const downloadError = withLinuxUpdateHelp({ status: "error", message } as const, `v${downloadingVersion}`);
      setUpdateStatusUnlessDownloaded(downloadError);
      logMain("warn", "updater", "update download failed", message);
      return downloadedUpdateMatchesChannel(selection) ?? downloadError;
    }
    // The download resolved after a cancel we could not deliver in time (the
    // token was already past its last abort point). Report what happened
    // rather than what was asked for — an update IS on disk.

    // macOS: a superseding download is installable only once Squirrel.Mac has
    // staged it. Hold the check until then, so its outcome names the build a
    // Restart would actually install.
    if (pendingSquirrelStage) await pendingSquirrelStage;
  }
  // Nothing replaced the held download: no download started, or one finished
  // without `update-downloaded`. Whatever is still installable is the answer.
  abandonSupersede("no newer download arrived");
  const matchingDownloadedResult = downloadedUpdateMatchesChannel(selection);
  if (matchingDownloadedResult) return matchingDownloadedResult;
  if (!result || !result.updateInfo) {
    return {
      status: "no-update",
      version: result?.updateInfo?.version ?? "unknown"
    };
  }
  if (
    result.isUpdateAvailable === false ||
    result.updateInfo.version === currentVersion
  ) {
    const skipped = {
      status: "no-update",
      version: result.updateInfo.version
    } as const;
    setUpdateStatusUnlessDownloaded(skipped);
    return skipped;
  }
  return { status: "available", version: result.updateInfo.version };
}

// Nobody awaits a background check, so its failure has to die here. Rate
// limiting makes a rejection routine rather than exceptional — without this
// the startup check and every hourly tick raise an unhandled rejection in
// main, which has no process-level handler.
function runBackgroundUpdateCheck(
  trigger: "startup" | "periodic" | "selection" | "settings"
): void {
  void checkForAppUpdatesNow(trigger)
    .catch((err: unknown) => {
      if (err instanceof DeferredReleaseCheck) return;
      logMain(
        "warn",
        "updater",
        `${trigger} update check failed`,
        err instanceof Error ? err.message : String(err)
      );
    })
    .finally(() => scheduleNextUpdateCheck());
}

/** Dev/QA stand-in for a real update check.
 *
 *  Real auto-update only runs in production — the dev binary is unsigned and
 *  has no release feed — so the update toast could not otherwise be seen
 *  without cutting a release, which is exactly how v0.7.0 shipped a menu
 *  check that answered with a modal telling the user to go to Settings.
 *  A *user-initiated* check therefore walks the status machine to a fake
 *  `downloaded@420.0.0`, broadcasting each transition so the whole flow —
 *  checking → available → downloading → downloaded → toast — is exercisable
 *  in `pnpm dev`.
 *
 *  Startup and periodic triggers stay silent (status `skipped`) so a dev
 *  launch never raises a toast on its own, and neither does the Playwright
 *  harness, which also runs unpackaged. Restart on the fake update is a
 *  no-op — see `installDownloadedAppUpdate`. */
async function simulateDevUpdateCheck(
  trigger: AppUpdateCheckTrigger
): Promise<AppUpdateCheckResult> {
  if (trigger !== "manual" && trigger !== "menu") {
    const skipped = developmentUpdateCheckResult();
    setUpdateStatus(skipped);
    return skipped;
  }
  // Join an in-flight simulation so mashing the menu item doesn't stack
  // overlapping animations racing on setUpdateStatus.
  if (updateCheckInFlight) return updateCheckInFlight;
  // The real check keeps a held download when the feed has nothing newer
  // (`runReleaseCheck`), and the fake's feed only ever has the one version,
  // so a repeat ends here — otherwise it would tear the offer down to
  // `checking` and rebuild it, which production never does.
  const alreadyOffered = downloadedUpdateMatchesChannel(
    currentUpdateSelectionKey()
  );
  if (alreadyOffered) return alreadyOffered;
  const version = DEV_FAKE_UPDATE_VERSION;
  logMain("info", "updater", `simulating dev update check (${trigger})`);
  updateCheckInFlight = (async (): Promise<AppUpdateCheckResult> => {
    const stepMs = devFakeUpdateStepMs();
    setUpdateStatus({ status: "checking" });
    await delay(stepMs, { unref: true });
    // The fake has no request to abort, so its cancel is the flag alone — but
    // it must be registered at the same point and read at the same cadence a
    // real download's would be, or the Cancel button is only ever exercised
    // against production code nobody can run in `pnpm dev`. Registered before
    // `available`, which is the status that puts the button on screen.
    const download: ActiveDownload = {
      version,
      cancel: () => {},
      canceled: false
    };
    activeDownload = download;
    const canceled = { status: "canceled", version } as const;
    try {
      setUpdateStatus({ status: "available", version });
      await delay(stepMs, { unref: true });
      for (const percent of DEV_FAKE_UPDATE_PERCENT_STEPS) {
        if (download.canceled) {
          setUpdateStatus(canceled);
          return canceled;
        }
        setUpdateStatus({
          status: "downloading",
          version,
          percent,
          transferred: Math.round(
            (DEV_FAKE_UPDATE_TOTAL_BYTES * percent) / 100
          ),
          total: DEV_FAKE_UPDATE_TOTAL_BYTES
        });
        await delay(stepMs, { unref: true });
      }
      // Once more after the loop: a cancel during the last step would
      // otherwise be dropped, and the preview would offer a Restart for an
      // update the user had just declined.
      if (download.canceled) {
        setUpdateStatus(canceled);
        return canceled;
      }
    } finally {
      if (activeDownload === download) activeDownload = undefined;
    }
    heldDownloadedUpdate = {
      selection: currentUpdateSelectionKey(),
      version
    };
    reconcileDownloadedUpdateEligibility();
    return { status: "downloaded", version };
  })();
  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = undefined;
  }
}

function scheduleNextUpdateCheck(): void {
  if (
    !initialized || !productionUpdatesEnabled() || linuxManualPackageUpdatesEnabled()
  ) return;
  if (periodicUpdateCheckTimer) clearTimeout(periodicUpdateCheckTimer);
  let wait = APP_UPDATE_CHECK_INTERVAL_MS;
  try {
    const due = getReleaseStore().automaticCheckAt() - Date.now();
    if (due > 0) wait = due;
  } catch {
    // Persistence failures already surface on the check. Retry next hour;
    // never make an unrecorded request or spin on a broken state directory.
  }
  periodicUpdateCheckTimer = setTimeout(() => {
    runBackgroundUpdateCheck("periodic");
  }, Math.min(wait, 2_147_483_647));
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

// A suffix-free final staged as a GitHub prerelease for smoke testing, or a
// `-prerelease.N` Stable candidate. Either is ahead of Stable Latest until
// promotion, so prerelease followers on both trains must see it.
function isStableCandidateAheadOfLatest(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined
): boolean {
  if (release.prerelease !== true) return false;
  const parsed = parseSemver(release.tag_name);
  if (!parsed) return false;
  if (parsed.pre.length > 0 && parsed.pre[0] !== "prerelease") return false;
  return (
    stableLatest === undefined ||
    compareSemver(release.tag_name, stableLatest.tag_name) > 0
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
//   - beta latest        → highest newer-core `-beta`, falling back to Stable Latest
//   - beta prerelease    → max(stable latest, newer-core alpha/beta, staged
//                          suffix-free final or `-prerelease` candidate ahead
//                          of stable latest)
// The fallback lets installed alphas/betas upgrade to their stable final without
// changing the saved selection, so the next eligible main-train tag still wins.
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
  const betaLatest =
    byPrecedenceDesc.find((release) =>
      isBetaLatestRelease(release, stableLatest, publicReleases)
    ) ?? stableLatest;
  const stablePrerelease = byPrecedenceDesc.find((release) => {
    if (release === stableLatest) return true;
    if (release.prerelease !== true) return false;
    if (firstPrereleaseId(release.tag_name) === "alpha") return false;
    return !isBetaLatestRelease(release, stableLatest, publicReleases);
  });
  const betaPrerelease = byPrecedenceDesc.find(
    (release) =>
      release === stableLatest ||
      isBetaTrainRelease(release, stableLatest, publicReleases) ||
      isStableCandidateAheadOfLatest(release, stableLatest)
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
  // Universal remains mandatory: legacy clients and Intel Macs need a safe
  // fallback even when this release also offers a smaller Apple Silicon ZIP.
  const version = release.tag_name?.replace(/^v/i, "");
  const hasZip = hasUploadedReleaseAsset(release, (name) =>
    name === `PwrGit-${version}-universal-mac.zip`
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
  return hasMacUpdateAssets(release) || hasWindowsUpdateAssets(release) || hasLinuxUpdateAssets(release);
}

function hasLinuxUpdateAssets(release: GitHubRelease): boolean {
  const format = linuxPackageFormat();
  if (!format) return false;
  const version = release.tag_name?.replace(/^v/i, "");
  return hasUploadedReleaseAsset(release, name => name === linuxChannelFile()) &&
    hasUploadedReleaseAsset(release, name => name === `PwrGit-${version}${linuxArtifactSuffix(format)}`);
}

function hasCurrentPlatformUpdateAssets(release: GitHubRelease): boolean {
  if (process.platform === "darwin") return hasMacUpdateAssets(release);
  if (process.platform === "win32") return hasWindowsUpdateAssets(release);
  if (process.platform === "linux") return hasLinuxUpdateAssets(release);
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

function githubReleaseHeaders(etag?: string): HeadersInit {
  const token = githubUpdateToken();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "PwrGit",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    // GitHub only exempts correctly authenticated 304s from primary quota.
    // Anonymous conditional requests remain subject to the shared-IP limit.
    ...(etag ? { "If-None-Match": etag } : {})
  };
}

function readResponseHeader(
  response: Response,
  name: string
): string | undefined {
  return response.headers?.get?.(name) ?? undefined;
}

function rateLimitedError(resetAt: number): Error {
  const resumesAt = new Date(resetAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  return new Error(
    `GitHub rate limit reached. Update checks resume at ${resumesAt}.`
  );
}

// When does this 403/429 mean "rate limited", and until when? The primary
// hourly limit reports a spent budget in x-ratelimit-remaining and the window
// end in x-ratelimit-reset. The secondary ("abuse detection") limit leaves the
// hourly budget intact and sends Retry-After instead, so keying only off
// x-ratelimit-remaining would miss it. Undefined means this is a real 403.
function rateLimitResetFromResponse(response: Response): number | undefined {
  if (readResponseHeader(response, "x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(
      readResponseHeader(response, "x-ratelimit-reset")
    );
    return Number.isFinite(resetSeconds) && resetSeconds > 0
      ? resetSeconds * 1_000
      : Date.now() + RATE_LIMIT_FALLBACK_BACKOFF_MS;
  }
  const retryAfterSeconds = Number(readResponseHeader(response, "retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Date.now() + retryAfterSeconds * 1_000;
  }
  return undefined;
}

// A 403 here reads like an auth failure but is almost always a rate limit.
// Record the reset time so later reads back off instead of spending requests
// GitHub will reject anyway.
function releaseRequestError(response: Response): Error {
  const status = response.status;
  const resetAt =
    status === 403 || status === 429
      ? rateLimitResetFromResponse(response)
      : undefined;
  if (resetAt === undefined) {
    return new Error(`GitHub releases request failed with ${status}`);
  }
  getReleaseStore().state.rateLimitResetAt = resetAt;
  logMain(
    "warn",
    "updater",
    `GitHub release rate limit reached status=${status} resetAt=${new Date(resetAt).toISOString()}`
  );
  return rateLimitedError(resetAt);
}

async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
  const store = getReleaseStore();
  const state = store.state;
  // Write ahead: even a killed process or a lost response consumes its slot.
  state.lastAttemptAt = Date.now();
  store.save();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: githubReleaseHeaders(state.cache?.etag),
      signal: controller.signal
    });
    if (response.status === 304 && state.cache) {
      state.cache = { ...state.cache, fetchedAt: Date.now() };
    } else {
      if (!response.ok) throw releaseRequestError(response);
      const releases = parseGitHubReleases(await response.json());
      const etag = readResponseHeader(response, "etag");
      state.cache = { ...(etag ? { etag } : {}), fetchedAt: Date.now(), releases };
    }
    state.lastSuccessAt = Date.now();
    // A successful response can spend the last available request, too.
    state.rateLimitResetAt = rateLimitResetFromResponse(response);
    state.retryNotBefore = undefined;
    state.failures = 0;
    store.save();
    return state.cache.releases;
  } catch (error) {
    state.failures = Math.min(state.failures + 1, 10);
    // All errors get durable backoff, not just 403. Explicit checks bypass
    // normal cadence, but must respect failures and server reset instructions.
    state.retryNotBefore = Date.now() + Math.min(
      60_000 * 2 ** (state.failures - 1), APP_UPDATE_CHECK_INTERVAL_MS
    );
    store.save();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** One release-list budget for all windows, versions and channels in userData. */
async function readGitHubReleases(
  maxAgeMs = APP_UPDATE_RELEASE_CACHE_TTL_MS
): Promise<GitHubRelease[]> {
  const store = getReleaseStore();
  const state = store.state;
  const now = Date.now();
  if (releaseFetchInFlight) return await releaseFetchInFlight;
  if (state.cache && now - state.cache.fetchedAt < maxAgeMs) return state.cache.releases;
  if (state.rateLimitResetAt !== undefined && now < state.rateLimitResetAt) {
    if (maxAgeMs > 0 && state.cache) return state.cache.releases;
    throw rateLimitedError(state.rateLimitResetAt);
  }
  if (state.retryNotBefore !== undefined && now < state.retryNotBefore) {
    if (maxAgeMs > 0 && state.cache) return state.cache.releases;
    throw new Error("Update checks are backing off after a failed request. Try again shortly.");
  }
  if (maxAgeMs > 0 && now < store.automaticFetchAt()) {
    if (state.cache) return state.cache.releases;
    const resumesAt = new Date(store.automaticFetchAt()).toLocaleTimeString();
    throw new DeferredReleaseCheck(
      `Automatic release checks are deferred until ${resumesAt}.` +
      (linuxManualPackageUpdatesEnabled() ? "" : " Use Check for Update to check now.")
    );
  }
  releaseFetchInFlight = fetchGitHubReleases().finally(() => {
    releaseFetchInFlight = undefined;
  });
  return await releaseFetchInFlight;
}

async function readAppUpdateReleaseForChannel(
  channel: UpdateChannel,
  train: UpdateTrain,
  maxAgeMs?: number
): Promise<GitHubRelease | undefined> {
  const releases = await readGitHubReleases(maxAgeMs);
  return releaseForSelection(selectAppUpdateReleases(releases), channel, train);
}

function unavailableReleaseVersions(reason: string): AppUpdateReleaseVersions {
  const unavailable = { unavailableReason: reason };
  return {
    fetchedAt: Date.now(),
    stable: { latest: unavailable, prerelease: unavailable },
    beta: { latest: unavailable, prerelease: unavailable }
  };
}

export async function readAppUpdateReleaseVersions(): Promise<AppUpdateReleaseVersions> {
  // An unpackaged build can never install what it finds, so reading the list
  // is pure cost: every dev launch and every e2e run that opens Settings →
  // Updates would spend one of the 60 anonymous requests per hour this
  // machine's IP gets, and make the panel depend on the network.
  if (!productionUpdatesEnabled()) {
    return unavailableReleaseVersions(
      "Release versions are not fetched in development builds."
    );
  }
  try {
    const releases = await readGitHubReleases();
    const selected = process.platform === "linux"
      ? selectAppUpdateReleases(releases)
      : selectPublishedUpdateReleases(releases);
    // The matrix can discover a release between hourly checks. Start the
    // download from the same cached list, without delaying the Settings read.
    const selection = currentSelection();
    const offered = releaseForSelection(
      selectAppUpdateReleases(releases),
      selection.channel,
      selection.train
    )?.tag_name?.replace(/^v/i, "");
    // A held download only yields to a release newer than itself.
    const held = downloadedUpdateMatchesChannel(
      updateSelectionKey(selection.train, selection.channel)
    );
    if (
      initialized &&
      offered &&
      compareSemver(offered, autoUpdater.currentVersion?.version ?? "unknown") > 0 &&
      (held === undefined ||
        (parseSemver(held.version) !== undefined &&
          compareSemver(offered, held.version) > 0)) &&
      !(updateStatus.status === "canceled" && updateStatus.version === offered)
    ) {
      runBackgroundUpdateCheck("settings");
    }
    return {
      fetchedAt: getReleaseStore().state.cache?.fetchedAt ?? Date.now(),
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
    return unavailableReleaseVersions(
      err instanceof Error ? err.message : String(err)
    );
  }
}

export function initAutoUpdater(options: AutoUpdaterOptions): void {
  if (initialized) return;
  initialized = true;
  resolveSelection = options.resolveSelection;
  beforeQuitAndInstall = options.beforeQuitAndInstall;
  observedSelection = currentUpdateSelectionKey();

  if (!productionUpdatesEnabled()) {
    logMain("info", "updater", "auto-update disabled in non-packaged builds");
    setUpdateStatus(developmentUpdateCheckResult());
    return;
  }

  if (linuxManualPackageUpdatesEnabled()) {
    logMain("info", "updater", "auto-update disabled for portable or unsupported Linux builds");
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
  autoUpdater.autoInstallOnAppQuit = process.platform !== "linux";
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
      activeDownload?.version ??
      (updateStatus.status === "available" ||
      updateStatus.status === "downloading"
        ? updateStatus.version
        : "unknown");
    // The bytes come along for the meter's label: a percent alone cannot tell
    // a 4 MB delta apart from a 120 MB full download, and on a slow link the
    // difference is the whole question of whether waiting is worth it.
    setUpdateStatus({
      status: "downloading",
      version,
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });
  // electron-updater reports its own aborts here and, deliberately, not
  // through `error`. Settling on `canceled` rather than back on `available`
  // keeps Settings from promising a download that is no longer running.
  autoUpdater.on("update-cancelled", (info) => {
    const version = info?.version ?? activeDownload?.version ?? "unknown";
    logMain("info", "updater", `update-cancelled ${version}`);
    if (info?.version) pendingDownloadChannelsByVersion.delete(info.version);
    setUpdateStatusUnlessDownloaded({ status: "canceled", version });
  });
  autoUpdater.on("update-downloaded", (info) => {
    logMain("info", "updater", `update-downloaded ${info.version}`);
    const selection = info.version
      ? (pendingDownloadChannelsByVersion.get(info.version) ??
        currentUpdateSelectionKey())
      : undefined;
    if (info.version) pendingDownloadChannelsByVersion.delete(info.version);
    if (info.version && selection) {
      const next: HeldDownload = { selection, version: info.version };
      if (supersedingDownload !== undefined && process.platform === "darwin") {
        // Not installable yet: Squirrel.Mac still has the older build staged.
        // Listen now — MacUpdater emits this before asking Squirrel to fetch.
        const stage = awaitSquirrelStage(next).finally(() => {
          if (pendingSquirrelStage === stage) pendingSquirrelStage = undefined;
        });
        pendingSquirrelStage = stage;
        return;
      }
      promoteSupersede(next);
      return;
    }
    supersedingDownload = undefined;
    reconcileDownloadedUpdateEligibility();
  });
  autoUpdater.on("error", (err: Error) => {
    logMain("warn", "updater", "auto-update error", err.message);
    setUpdateStatusUnlessDownloaded({ status: "error", message: err.message });
  });

  runBackgroundUpdateCheck("startup");
}

/**
 * Stop the download the update toast is reporting.
 *
 * `canceled: false` is the ordinary race, not a fault: the download finished
 * (or never started) while the click was in flight. The caller has a check
 * result coming either way, so there is nothing for it to do about that.
 */
export function cancelAppUpdateDownload(): AppUpdateCancelResult {
  const download = activeDownload;
  if (!download || download.canceled) return { canceled: false };
  download.canceled = true;
  logMain("info", "updater", `canceling update download ${download.version}`);
  // The flag is set first and unconditionally: `cancel` may be the empty slot
  // an offered-but-not-yet-started download carries, and it may throw (the
  // token is electron-updater's). Either way the download's own rejection
  // must still read as a cancel rather than as a network failure.
  applyPendingCancel(download);
  return { canceled: true };
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
  if (!productionUpdatesEnabled()) {
    // The only way to reach `downloaded` outside production is the dev/QA
    // fake (see `simulateDevUpdateCheck`): there is no payload and the dev
    // binary is unsigned, so say so in the toast rather than bouncing the app
    // through quitAndInstall.
    logMain("info", "updater", `dev fake update ${version} — restart is a no-op`);
    return {
      status: "error",
      message: `Dev preview (v${version}): Restart only works in production builds.`
    };
  }
  if (nativeLinuxInstallAccepted) return { status: "restarting" };
  try {
    logMain("info", "updater", `installing downloaded update ${version}`);
    if (linuxPackageFormat()) {
      // Native package installation and authorization are synchronous in 6.8.9.
      // Failure emits an error and resets the install latch for retry. Success
      // arms relaunch, then queues app.quit via setImmediate. Start our drain
      // before that queued quit, then resume it after the bounded flush: PwrGit's
      // flushForUpdate takes ownership and prevents the updater's early quit.
      let installError: Error | undefined;
      const captureError = (error: Error): void => { installError = error; };
      autoUpdater.once("error", captureError);
      try {
        autoUpdater.quitAndInstall();
      } finally {
        autoUpdater.removeListener("error", captureError);
      }
      if (installError) return withLinuxUpdateHelp({
        status: "error" as const,
        message: `Installation failed or authorization was canceled: ${installError.message}`
      }, `v${version}`);
      nativeLinuxInstallAccepted = true;
      await beforeQuitAndInstall?.();
      app.quit();
    } else {
      await beforeQuitAndInstall?.();
      autoUpdater.quitAndInstall();
    }
    return { status: "restarting" };
  } catch (err) {
    return withLinuxUpdateHelp({
      status: "error" as const,
      message: err instanceof Error ? err.message : String(err)
    }, `v${version}`);
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
  bus.register("app:cancelUpdateDownload", () =>
    ok(cancelAppUpdateDownload())
  );
}
