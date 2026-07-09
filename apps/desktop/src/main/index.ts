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
import {
  createWorktreeRefresher,
  registerWorktreeHandlers
} from "./git/worktree-handlers";
import { registerWorktreeLifecycleHandlers } from "./git/worktree-lifecycle-handlers";
import { WorktreeStateService } from "./git/worktree-state";
import { registerGitHubHandlers } from "./github/github-handlers";
import { PrService } from "./github/pr-service";
import { emitEvent, registerIpc } from "./ipc";
import { openDatabase } from "./persistence/db";
import { readGitIdentityDefaults } from "./profiles/git-identity";
import { registerProfileHandlers } from "./profiles/profile-handlers";
import { ProfileService } from "./profiles/profile-service";
import { registerShellHandlers } from "./shell-handlers";
import { SettingsService } from "./settings/settings-service";
import { createMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;

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
    const settings = new SettingsService(
      join(app.getPath("userData"), "settings.json")
    );
    const profiles = new ProfileService(db);
    // PWRGIT_GITCONFIG (e2e seam) pins the seeded identity to a known file.
    const identity = readGitIdentityDefaults(process.env["PWRGIT_GITCONFIG"]);
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

    // Switching profiles kicks a background rescan of the newly active one.
    registerProfileHandlers(bus, profiles, rescanInBackground);
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

    registerIpc(bus);
    mainWindow = createMainWindow();
    initAutoUpdater();

    const refreshActive = (): void => {
      if (activeWorktreeId !== null) refresher.refreshWorktree(activeWorktreeId);
    };
    mainWindow.on("focus", refreshActive);
    const activeStatePoll = setInterval(() => {
      if (mainWindow?.isFocused() === true) refreshActive();
    }, 15_000);
    app.on("before-quit", () => clearInterval(activeStatePoll));

    // Scan the active profile so the sidebar lists its repos.
    const activeId = profiles.getActiveId();
    const activeProfile = activeId === null ? null : profiles.get(activeId);
    if (activeProfile !== null) rescanInBackground(activeProfile);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
