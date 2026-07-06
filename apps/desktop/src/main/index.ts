import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { ok, type Profile } from "@pwrgit/shared";
import { CommandBus } from "./command-bus";
import { registerDialogHandlers } from "./dialog-handlers";
import { execGit } from "./git/dugite";
import { registerRemoteHandlers } from "./git/remote-handlers";
import { registerRepoHandlers } from "./git/repo-handlers";
import { RepoIndexer } from "./git/repo-indexer";
import { WorktreeWatchers } from "./git/watchers";
import {
  createWorktreeRefresher,
  registerWorktreeHandlers
} from "./git/worktree-handlers";
import { WorktreeStateService } from "./git/worktree-state";
import { emitEvent, registerIpc } from "./ipc";
import { openDatabase } from "./persistence/db";
import { readGitIdentityDefaults } from "./profiles/git-identity";
import { registerProfileHandlers } from "./profiles/profile-handlers";
import { ProfileService } from "./profiles/profile-service";
import { createMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;

const bus = new CommandBus();
bus.register("ping", () => ok("pong"));

/**
 * Single-instance: PwrGit is a single-instance app (profiles switch in-app,
 * not by spawning new processes). A second launch focuses the existing window
 * instead of opening another.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    const db = openDatabase(join(app.getPath("userData"), "pwrgit.db"));
    const profiles = new ProfileService(db);
    const identity = readGitIdentityDefaults();
    profiles.ensureSeed({
      name: identity.name ?? "Default",
      email: identity.email ?? "",
      mono: "",
      kind: "Personal",
      roots: []
    });
    const indexer = new RepoIndexer(db, execGit);
    const stateService = new WorktreeStateService(db, execGit);
    const refresher = createWorktreeRefresher(stateService, db);
    const watchers = new WorktreeWatchers({
      onRepoRefsChanged: (repoId) => refresher.refreshRepoWorktrees(repoId),
      onWorktreeTreeChanged: (worktreeId) =>
        refresher.refreshWorktree(worktreeId)
    });

    const rescanInBackground = (profile: Profile): void => {
      void indexer
        .rescanProfile(profile)
        .then((repos) => {
          emitEvent("repo:changed", { profileId: profile.id });
          // Watch each repo's refs; compute every worktree's state in the
          // background, then refresh the sidebar badges when it settles.
          const worktreeIds: string[] = [];
          for (const repo of repos) {
            watchers.watchRepoRefs(repo.id, repo.path);
            for (const wt of repo.worktrees) worktreeIds.push(wt.id);
          }
          void stateService
            .refreshMany(worktreeIds)
            .then(() => emitEvent("repo:changed", { profileId: profile.id }));
        })
        .catch(() => undefined);
    };

    // Switching profiles kicks a background rescan of the newly active one.
    registerProfileHandlers(bus, profiles, rescanInBackground);
    registerRepoHandlers(bus, indexer, profiles);
    registerWorktreeHandlers(bus, stateService, watchers, db, refresher);
    registerRemoteHandlers(bus, db, refresher);
    registerDialogHandlers(bus);

    registerIpc(bus);
    mainWindow = createMainWindow();

    // Fill the sidebar for the active profile without blocking window creation.
    const activeId = profiles.getActiveId();
    const activeProfile = activeId === null ? null : profiles.get(activeId);
    if (activeProfile !== null) rescanInBackground(activeProfile);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });

    app.on("before-quit", () => {
      void watchers.closeAll();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
