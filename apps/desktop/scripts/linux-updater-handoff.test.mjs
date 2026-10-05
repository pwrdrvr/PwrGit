import Module, { createRequire } from "node:module";
import { expect, test } from "vitest";
import { createQuitDrain } from "../src/main/bounded-shutdown";

const require = createRequire(import.meta.url);

test.each(["DebUpdater", "RpmUpdater", "PacmanUpdater"])("pinned %s authorizes before the PwrGit shutdown drain and permits retry", async backend => {
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === "electron") return { autoUpdater: { emit() {} } };
    return originalLoad.call(this, id, ...args);
  };
  try {
    const Constructor = require("electron-updater")[backend];
    const sequence = [];
    let resolveFlush;
    const flush = new Promise(resolve => { resolveFlush = resolve; });
    const drain = createQuitDrain({
      stop: () => { sequence.push("stop"); return flush; },
      resumeQuit: () => { throw new Error("The update owns quit"); }, warn() {}
    });
    const quit = () => {
      sequence.push(drain.beforeQuit({ preventDefault() {} }) ? "held-quit" : "quit");
    };
    const adapter = { version: "1.0.0", name: "PwrGit", isPackaged: true,
      relaunch: () => sequence.push("relaunch"), quit };
    const updater = new Constructor(null, adapter);
    updater.autoInstallOnAppQuit = false;
    updater.logger = { info() {}, warn() {}, error() {} };
    updater.downloadedUpdateHelper = { file: `/fixture/PwrGit.${backend === "DebUpdater" ? "deb" : backend === "RpmUpdater" ? "rpm" : "pacman"}`, downloadedFileInfo: {} };
    updater.hasCommand = () => true;
    updater.detectPackageManager = () => backend === "DebUpdater" ? "dpkg" : backend === "RpmUpdater" ? "rpm" : "pacman";
    let authorized = false;
    updater.runCommandWithSudoIfNeeded = () => {
      if (!authorized) throw new Error("Not authorized");
      sequence.push("install");
    };
    const failures = [];
    updater.on("error", error => failures.push(error.message));
    updater.quitAndInstall();
    expect(failures).toContain("Not authorized");
    await new Promise(setImmediate);
    expect(sequence).toEqual([]);
    authorized = true;
    updater.quitAndInstall();
    expect(sequence).toEqual(["install", "relaunch"]);
    const preparing = drain.flushForUpdate();
    await new Promise(setImmediate);
    expect(sequence).toEqual(["install", "relaunch", "stop", "held-quit"]);
    resolveFlush();
    await preparing;
    quit();
    expect(sequence.at(-1)).toBe("quit");
  } finally {
    Module._load = originalLoad;
  }
});
