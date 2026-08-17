import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage
} from "electron";
import {
  ok,
  resolveUpdateSelection,
  type Profile,
  type RemoteBranchReveal
} from "@pwrgit/shared";
import { registerAppDocumentHandlers } from "./app-document-handlers";
import { wireAppMenuBridge } from "./app-menu-bridge";
import { openAppDocumentWindow } from "./app-document-window";
import {
  initAutoUpdater,
  reconcileDownloadedUpdateEligibility,
  registerAppUpdateHandlers
} from "./auto-updater";
import { CommandBus } from "./command-bus";
import { registerDialogHandlers } from "./dialog-handlers";
import { execGit } from "./git/dugite";
import { registerBranchHandlers } from "./git/branch-handlers";
import { registerCloneHandlers } from "./git/clone-handlers";
import { CloneService } from "./git/clone-service";
import { registerChangesHandlers } from "./git/changes-handlers";
import { registerGraphHandlers } from "./git/graph-handlers";
import { registerRebaseHandlers } from "./git/rebase-handlers";
import { registerRemoteHandlers } from "./git/remote-handlers";
import { registerRepoHandlers } from "./git/repo-handlers";
import { RepoIndexer } from "./git/repo-indexer";
import { registerSearchStatusHandlers } from "./git/search-status-handlers";
import {
  createWorktreeRefresher,
  registerWorktreeHandlers
} from "./git/worktree-handlers";
import { WorktreeOperationQueue } from "./git/worktree-operation-queue";
import { registerWorktreeLifecycleHandlers } from "./git/worktree-lifecycle-handlers";
import { WorktreeStateService } from "./git/worktree-state";
import {
  GITHUB_AVATAR_THUMBNAIL_PROTOCOL_SCHEME,
  GitHubAvatarThumbnailCache
} from "./github/avatar-thumbnail-cache";
import { GitHubCommitAuthorIdentityService } from "./github/commit-author-identity";
import { registerGitHubHandlers } from "./github/github-handlers";
import { PrService } from "./github/pr-service";
import { emitEvent, registerIpc } from "./ipc";
import {
  initLogFile,
  logMain,
  readLogSnapshot,
  subscribeLogEntries
} from "./logs";
import { openLogsWindow } from "./logs-window";
import { ensureMacKeychainAccess } from "./mac-keychain-access";
import { openDatabase } from "./persistence/db";
import { readGitIdentityDefaults } from "./profiles/git-identity";
import { registerProfileHandlers } from "./profiles/profile-handlers";
import { ProfileService } from "./profiles/profile-service";
import { registerShellHandlers } from "./shell-handlers";
import { SettingsService } from "./settings/settings-service";
import {
  registerSettingsHandlers,
  settingsSnapshot
} from "./settings/settings-handlers";
import {
  DiagnosticsManager,
  startStartupCpuProfiling
} from "./diagnostics/diagnostics-manager";
import { rebuildAppMenu } from "./menu";
import { createProfileWindows } from "./profile-windows";
import { openSettingsWindow } from "./settings-window";
import { applyNativeWindowTheme } from "./window-chrome";

const APP_NAME = "PwrGit";

// The renderer gets only opaque, versioned local thumbnail URLs. Mark the
// scheme standard + secure before Electron is ready so Chromium can retain
// image responses between short-lived commit context cards.
protocol.registerSchemesAsPrivileged([
  {
    scheme: GITHUB_AVATAR_THUMBNAIL_PROTOCOL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

// Playwright launches the built main entry directly, so Electron cannot find
// apps/desktop/package.json and otherwise identifies the process as the generic
// "Electron" app. Establish PwrGit's runtime identity before userData is
// derived or the single-instance lock is requested. Packaged builds already
// carry the product name, but setting it explicitly keeps every launch mode
// consistent.
app.setName(APP_NAME);
// PwrGit currently renders dark-only. Keep Electron-owned popup menus and
// dialogs on that same theme; the shared chrome helper is ready to switch this
// alongside the renderer when the authored light theme becomes selectable.
applyNativeWindowTheme(nativeTheme);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion()
});

// Packaged builds ship dugite's embedded git under Contents/Resources/git
// (resources/git on Windows) via electron-builder extraResources, because the
// distribution's ~150 `git-<builtin> → git` symlinks cannot live inside
// app.asar.unpacked (the universal-merge asar writer refuses duplicate
// symlinks). dugite reads LOCAL_GIT_DIRECTORY at every exec, so pointing it
// at resourcesPath redirects all git spawns. Dev builds keep dugite's default
// node_modules-relative path.
if (app.isPackaged && !process.env["LOCAL_GIT_DIRECTORY"]) {
  process.env["LOCAL_GIT_DIRECTORY"] = join(process.resourcesPath, "git");
}

// Relocate all app data (db, settings, profiles) to an explicit directory when
// PWRGIT_USER_DATA_DIR is set. e2e uses this to give each run an isolated,
// disposable data dir; unset in normal use, so production is unaffected. Must
// run before anything reads app.getPath("userData").
const dataDirOverride = process.env["PWRGIT_USER_DATA_DIR"];
if (dataDirOverride !== undefined && dataDirOverride !== "") {
  app.setPath("userData", dataDirOverride);
}

const bus = new CommandBus();
bus.register("ping", () => ok("pong"));

// Development launches do not pass through electron-builder, so macOS would
// otherwise show the generic Electron tile in the Dock. Packaged builds use
// build/icon.icns through electron-builder instead.
function installDevelopmentDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged) return;

  const iconPath = join(app.getAppPath(), "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    logMain("warn", "app", "failed to load development Dock icon", { iconPath });
    return;
  }

  app.dock?.setIcon(icon);
}

/**
 * Single-instance: PwrGit is a single-instance app — one window per profile
 * inside it. A second launch focuses an existing window instead of spawning
 * another process.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    wireAppMenuBridge();
    // App log: ring buffer + file, streamed to the Logs window (Help › Logs).
    initLogFile(join(app.getPath("userData"), "pwrgit-main.log"));
    subscribeLogEntries((entry) => emitEvent("logs:entry", entry));
    logMain("info", "app", `PwrGit ${app.getVersion()} starting`);
    installDevelopmentDockIcon();
    bus.register("logs:read", () => ok(readLogSnapshot()));
    bus.register("logs:openWindow", () => {
      openLogsWindow();
      return ok(null);
    });
    registerAppDocumentHandlers(bus);

    const settings = new SettingsService(
      join(app.getPath("userData"), "settings.json")
    );
    const keychainReady = await ensureMacKeychainAccess({
      platform: process.platform,
      packaged: app.isPackaged,
      settings,
      showMessageBox: (options) => dialog.showMessageBox(options),
      encryptString: (plainText) => safeStorage.encryptString(plainText),
      onAccessDenied: () =>
        logMain("warn", "keychain", "macOS Keychain access was not granted")
    });
    if (!keychainReady) {
      logMain("info", "keychain", "startup canceled before opening a window");
      app.quit();
      return;
    }

    const db = openDatabase(join(app.getPath("userData"), "pwrgit.db"));
    const diagnosticsOutputRoot = join(app.getPath("userData"), "diagnostics");
    const diagnostics = new DiagnosticsManager({
      outputRoot: diagnosticsOutputRoot,
      getDiagnostics: () =>
        settingsSnapshot(settings, diagnosticsOutputRoot).diagnostics,
      onHotCpuHeapSnapshotLimitReached: () => {
        // Mirror PwrAgnt: a session that hits its heap-snapshot cap turns the
        // capture flag off so the next arm doesn't silently refill the disk.
        settings.update({
          diagnostics: {
            ...settings.get().diagnostics,
            hotCpuProfilingCaptureHeapSnapshot: false
          }
        });
        emitEvent(
          "settings:changed",
          settingsSnapshot(settings, diagnosticsOutputRoot)
        );
        diagnostics.sync();
      }
    });
    // Startup CPU profiling must begin before the first window exists to
    // cover window creation; enabled via Settings toggle or PWRGIT_* env.
    const startupCpu = await startStartupCpuProfiling({
      enabled: settingsSnapshot(settings, diagnosticsOutputRoot).diagnostics
        .startupCpuProfilingEnabled,
      outputRoot: diagnosticsOutputRoot
    });
    let startupCpuWindowPending = startupCpu !== null;
    const profiles = new ProfileService(db);
    // PWRGIT_GITCONFIG (e2e seam) pins the seeded identity to a known file.
    // The profile NAME is a workspace label ("Personal", "Acme", "PwrDrvr"),
    // not a person — the git identity name seeds the commit AUTHOR instead.
    // (Seeding name from user.name gave every profile the same title.)
    const identity = readGitIdentityDefaults(process.env["PWRGIT_GITCONFIG"]);
    profiles.ensureSeed({
      name: "Personal",
      email: identity.email ?? "",
      ...(identity.name !== undefined ? { authorName: identity.name } : {}),
      mono: "",
      kind: "Personal",
      roots: []
    });
    const indexer = new RepoIndexer(db, execGit);
    const cloneService = new CloneService(db, execGit, indexer, profiles);
    const worktreeOperations = new WorktreeOperationQueue();
    const stateService = new WorktreeStateService(
      db,
      execGit,
      worktreeOperations
    );
    const refresher = createWorktreeRefresher(stateService, db);
    const prService = new PrService(db, execGit);
    const avatarThumbnails = new GitHubAvatarThumbnailCache(db, {
      cacheDir: join(app.getPath("userData"), "cache", "github-avatar-thumbnails")
    });
    protocol.handle(GITHUB_AVATAR_THUMBNAIL_PROTOCOL_SCHEME, (request) =>
      avatarThumbnails.respondToRendererUrl(request.url)
    );
    const commitAuthorIdentityService = new GitHubCommitAuthorIdentityService(
      db,
      execGit,
      { thumbnailStore: avatarThumbnails }
    );

    // The worktree the user is currently viewing; refreshed on focus + a gentle
    // interval instead of via filesystem watchers (which peg fseventd on large
    // trees). PwrGit's own git ops refresh directly through the refresher.
    let activeWorktreeId: string | null = null;
    const rescanningProfiles = new Set<string>();

    const rescanInBackground = (profile: Profile): void => {
      if (
        rescanningProfiles.has(profile.id) ||
        !indexer.shouldRescanProfile(profile.id)
      ) {
        return;
      }
      // Scan lists repos + worktrees (cheap). Per-worktree *state*
      // (dirty/ahead/behind/staleness) is computed lazily per repo when its row
      // is expanded (repo:computeState) — computing all 156 at launch storms git.
      const startedAt = Date.now();
      rescanningProfiles.add(profile.id);
      void indexer
        .rescanProfile(profile)
        .then((repos) => {
          logMain(
            "info",
            "scan",
            `rescanned profile "${profile.name}": ${repos.length} repos` +
              ` (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
          );
          emitEvent("repo:changed", { profileId: profile.id });
        })
        .catch((cause) => logMain("error", "scan", "rescan failed:", cause))
        .finally(() => rescanningProfiles.delete(profile.id));
    };

    // One window per profile. Opening a profile that already has a window
    // focuses it; cross-profile reveals are stashed until the new window asks.
    const windows = createProfileWindows();
    type Reveal = {
      repoId: string;
      worktreeId: string | null;
      remoteBranch: RemoteBranchReveal | null;
    };
    const pendingReveals = new Map<string, Reveal>();

    const refreshMenu = (): void => {
      rebuildAppMenu({
        profiles: profiles.snapshot().profiles,
        currentProfileId: windows.focusedProfileId() ?? profiles.getActiveId(),
        onOpenProfile: (profileId) => openProfileWindow(profileId),
        onNewProfile: () => emitEvent("ui:newProfile", {}),
        onManageProfiles: () => emitEvent("ui:manageProfile", {}),
        onOpenSettings: () => openSettingsWindow(),
        onOpenLogs: () => openLogsWindow(),
        onOpenLicense: () => openAppDocumentWindow("license"),
        onOpenThirdPartyNotices: () =>
          openAppDocumentWindow("third-party-notices"),
        developerMode: settingsSnapshot(settings, diagnosticsOutputRoot).general
          .developerMode
      });
    };

    const openProfileWindow = (
      profileId: string,
      revealRepoId?: string,
      revealWorktreeId?: string,
      revealRemoteBranch?: RemoteBranchReveal
    ): boolean => {
      const profile = profiles.get(profileId);
      if (profile === null) return false;
      profiles.switch(profileId); // record last-used (boot + activate default)
      rescanInBackground(profile);
      const wasOpen = windows.has(profileId);
      if (revealRepoId !== undefined) {
        const reveal: Reveal = {
          repoId: revealRepoId,
          worktreeId: revealWorktreeId ?? null,
          remoteBranch: revealRemoteBranch ?? null
        };
        if (wasOpen) emitEvent("ui:revealRepo", { profileId, ...reveal });
        else pendingReveals.set(profileId, reveal);
      }
      const opened = windows.open(profileId);
      if (opened.created) {
        diagnostics.attachWindow(opened.window);
        if (startupCpuWindowPending) {
          startupCpuWindowPending = false;
          startupCpu?.attachFirstWindow(opened.window);
        }
      }
      refreshMenu();
      return true;
    };

    registerProfileHandlers(bus, profiles, {
      onActivated: rescanInBackground,
      onChanged: refreshMenu,
      openWindow: openProfileWindow,
      consumeReveal: (profileId) => {
        const reveal = pendingReveals.get(profileId) ?? null;
        pendingReveals.delete(profileId);
        return reveal;
      }
    });
    registerRepoHandlers(bus, indexer, profiles, refresher);
    registerCloneHandlers(bus, cloneService);
    registerWorktreeHandlers(bus, stateService, db, refresher, execGit, (id) => {
      activeWorktreeId = id;
    });
    registerWorktreeLifecycleHandlers(bus, db, indexer, settings, stateService);
    registerBranchHandlers(
      bus,
      db,
      indexer,
      refresher,
      worktreeOperations,
      settings
    );
    registerRemoteHandlers(bus, db, refresher, worktreeOperations, indexer);
    registerGraphHandlers(bus, db, stateService);
    registerChangesHandlers(bus, db, refresher, worktreeOperations);
    registerRebaseHandlers(bus, db, refresher, worktreeOperations);
    registerDialogHandlers(bus);
    registerShellHandlers(bus);
    const githubHandlers = registerGitHubHandlers(
      bus,
      prService,
      commitAuthorIdentityService
    );
    registerSearchStatusHandlers(bus, db);
    registerSettingsHandlers(bus, settings, {
      diagnosticsOutputRoot,
      appVersion: app.getVersion(),
      onChanged: (snapshot) => {
        emitEvent("settings:changed", snapshot);
        diagnostics.sync();
        refreshMenu(); // Developer Mode toggles View-menu items live
      }
    });
    diagnostics.sync(); // start any settings-enabled monitors at boot

    registerIpc(bus, {
      onWebContentsDestroyed: githubHandlers.releaseWebContents
    });
    registerAppUpdateHandlers(bus);
    settings.onWrite(() => {
      reconcileDownloadedUpdateEligibility();
    });
    initAutoUpdater({
      resolveSelection: () =>
        resolveUpdateSelection(settings.get().updates, app.getVersion())
    });

    const refreshActive = (): void => {
      if (activeWorktreeId !== null) refresher.refreshWorktree(activeWorktreeId);
    };
    app.on("browser-window-focus", () => {
      refreshActive();
      refreshMenu();
    });
    const activeStatePoll = setInterval(() => {
      if (BrowserWindow.getFocusedWindow() !== null) refreshActive();
    }, 15_000);
    app.on("before-quit", () => {
      clearInterval(activeStatePoll);
      githubHandlers.stop();
    });

    // Drain diagnostics before quitting so final monitor-stopped events and
    // manifest writes land on disk. Bounded and fail-safe: the drain races a
    // timeout, and if the resumed quit is swallowed (automation teardown,
    // re-entrant quit), app.exit() guarantees the process still dies.
    let diagnosticsQuitState: "pending" | "draining" | "done" = "pending";
    app.on("will-quit", (event) => {
      if (diagnosticsQuitState === "done") return;
      event.preventDefault();
      if (diagnosticsQuitState === "draining") return; // drain will re-quit
      diagnosticsQuitState = "draining";
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 1_500)
      );
      void Promise.race([diagnostics.shutdown(), timeout]).finally(() => {
        diagnosticsQuitState = "done";
        app.quit();
        setTimeout(() => app.exit(0), 500);
      });
    });

    // Boot into the last-used profile's window (its rescan kicks off inside).
    const activeId = profiles.getActiveId();
    if (activeId !== null) openProfileWindow(activeId);
    refreshMenu();

    // Migration 0019 could not populate Git-derived rows in SQL. Repair only
    // repos that have never been attempted, after opening the first window.
    // The active profile's normal rescan owns its root-discovered repos, so
    // exclude only those scan rows. Manual repos still need this repair.
    setImmediate(() => {
      void indexer
        .hydrateRemoteBranches({ excludeScannedProfileId: activeId })
        .then(({ refreshed, failed }) => {
          if (refreshed === 0 && failed === 0) return;
          logMain(
            failed === 0 ? "info" : "warn",
            "scan",
            `hydrated missing remote branches for ${refreshed} repos` +
              (failed === 0 ? "" : `; ${failed} failed`)
          );
        })
        .catch((cause) =>
          logMain("error", "scan", "remote-branch hydration failed:", cause)
        );
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const lastActive = profiles.getActiveId();
        if (lastActive !== null) openProfileWindow(lastActive);
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
