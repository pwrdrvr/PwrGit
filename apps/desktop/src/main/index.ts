import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "./command-bus";
import { execGit } from "./git/dugite";
import { registerRepoHandlers } from "./git/repo-handlers";
import { RepoIndexer } from "./git/repo-indexer";
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
    registerProfileHandlers(bus, profiles);

    const indexer = new RepoIndexer(db, execGit);
    registerRepoHandlers(bus, indexer, profiles);

    registerIpc(bus);
    mainWindow = createMainWindow();

    // Kick a background rescan of the active profile so the sidebar fills in
    // without blocking window creation.
    const activeId = profiles.getActiveId();
    const activeProfile = activeId === null ? null : profiles.get(activeId);
    if (activeProfile !== null) {
      void indexer
        .rescanProfile(activeProfile)
        .then(() => emitEvent("repo:changed", { profileId: activeProfile.id }))
        .catch(() => undefined);
    }

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
