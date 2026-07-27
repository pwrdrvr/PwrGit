import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { ok, type Profile } from "@pwrgit/shared";
import { initAutoUpdater } from "./auto-updater";
import { CommandBus } from "./command-bus";
import { registerDialogHandlers } from "./dialog-handlers";
import { execGit } from "./git/dugite";
import { registerBranchHandlers } from "./git/branch-handlers";
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
import { registerWorktreeLifecycleHandlers } from "./git/worktree-lifecycle-handlers";
import { WorktreeStateService } from "./git/worktree-state";
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
import { openDatabase } from "./persistence/db";
import { readGitIdentityDefaults } from "./profiles/git-identity";
import { registerProfileHandlers } from "./profiles/profile-handlers";
import { ProfileService } from "./profiles/profile-service";
import { registerShellHandlers } from "./shell-handlers";
import { SettingsService } from "./settings/settings-service";
import { rebuildAppMenu } from "./menu";
import { createProfileWindows } from "./profile-windows";

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

  app.whenReady().then(() => {
    // App log: ring buffer + file, streamed to the Logs window (Help › Logs).
    initLogFile(join(app.getPath("userData"), "pwrgit-main.log"));
    subscribeLogEntries((entry) => emitEvent("logs:entry", entry));
    logMain("info", "app", `PwrGit ${app.getVersion()} starting`);
    bus.register("logs:read", () => ok(readLogSnapshot()));
    bus.register("logs:openWindow", () => {
      openLogsWindow();
      return ok(null);
    });

    const db = openDatabase(join(app.getPath("userData"), "pwrgit.db"));
    const settings = new SettingsService(
      join(app.getPath("userData"), "settings.json")
    );
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
    const stateService = new WorktreeStateService(db, execGit);
    const refresher = createWorktreeRefresher(stateService, db);
    const prService = new PrService(db, execGit);

    // The worktree the user is currently viewing; refreshed on focus + a gentle
    // interval instead of via filesystem watchers (which peg fseventd on large
    // trees). PwrGit's own git ops refresh directly through the refresher.
    let activeWorktreeId: string | null = null;

    const rescanInBackground = (profile: Profile): void => {
      // Scan lists repos + worktrees (cheap). Per-worktree *state*
      // (dirty/ahead/behind/staleness) is computed lazily per repo when its row
      // is expanded (repo:computeState) — computing all 156 at launch storms git.
      void indexer
        .rescanProfile(profile)
        .then(() => emitEvent("repo:changed", { profileId: profile.id }))
        .catch(() => undefined);
    };

    // One window per profile. Opening a profile that already has a window
    // focuses it; cross-profile reveals are stashed until the new window asks.
    const windows = createProfileWindows();
    type Reveal = { repoId: string; worktreeId: string | null };
    const pendingReveals = new Map<string, Reveal>();

    const refreshMenu = (): void => {
      rebuildAppMenu({
        profiles: profiles.snapshot().profiles,
        currentProfileId: windows.focusedProfileId() ?? profiles.getActiveId(),
        onOpenProfile: (profileId) => openProfileWindow(profileId),
        onNewProfile: () => emitEvent("ui:newProfile", {}),
        onManageProfiles: () => emitEvent("ui:manageProfile", {}),
        onOpenLogs: () => openLogsWindow()
      });
    };

    const openProfileWindow = (
      profileId: string,
      revealRepoId?: string,
      revealWorktreeId?: string
    ): boolean => {
      const profile = profiles.get(profileId);
      if (profile === null) return false;
      profiles.switch(profileId); // record last-used (boot + activate default)
      rescanInBackground(profile);
      const wasOpen = windows.has(profileId);
      if (revealRepoId !== undefined) {
        const reveal: Reveal = {
          repoId: revealRepoId,
          worktreeId: revealWorktreeId ?? null
        };
        if (wasOpen) emitEvent("ui:revealRepo", { profileId, ...reveal });
        else pendingReveals.set(profileId, reveal);
      }
      windows.open(profileId);
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
    registerRepoHandlers(bus, indexer, profiles);
    registerWorktreeHandlers(bus, stateService, db, refresher, (id) => {
      activeWorktreeId = id;
    });
    registerWorktreeLifecycleHandlers(bus, db, indexer, settings);
    registerBranchHandlers(bus, db, indexer, refresher);
    registerRemoteHandlers(bus, db, refresher);
    registerGraphHandlers(bus, db, stateService);
    registerChangesHandlers(bus, db, refresher);
    registerRebaseHandlers(bus, db, refresher);
    registerDialogHandlers(bus);
    registerShellHandlers(bus);
    registerGitHubHandlers(bus, prService);
    registerSearchStatusHandlers(bus, db);

    registerIpc(bus);
    initAutoUpdater();

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
    app.on("before-quit", () => clearInterval(activeStatePoll));

    // Boot into the last-used profile's window (its rescan kicks off inside).
    const activeId = profiles.getActiveId();
    if (activeId !== null) openProfileWindow(activeId);
    refreshMenu();

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
