// PwrGit quit probe.
//
//   pnpm --filter @pwrgit/desktop build
//   pnpm --filter @pwrgit/desktop probe:app-quit
//
// Runs the BUILT main bundle (out/main/index.js) on a throwaway userData,
// quits it the way ⌘Q does, and checks that Electron finishes the quit on
// its own: will-quit and quit emitted, no window-all-closed in their place,
// and the exit fail-safe in quit-retry.ts never needed. Playwright cannot
// catch a regression here, because it quits from JavaScript, which never
// nests (see src/main/quit-retry.ts).
//
// "Native" is SIGTERM, which Electron turns into a posted Browser::Quit task
// — the same shape as ⌘Q's `terminate:`. Two cases: nothing recording (quit
// goes straight through) and a startup CPU profile recording (quit is
// deferred for the flush, then resumed).
//
// Nothing is drawn: every window's show/focus is stubbed, the app runs under
// the accessory activation policy (no Dock icon, no focus taken), and the
// forge seam keeps it off the network. POSIX only.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SIGTERM_AFTER_LOAD_MS = 3_000;
const here = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes("--child")) await runChild();
else runParent();

function runParent() {
  if (process.platform === "win32") {
    console.log("app-quit-probe: POSIX only (it quits with SIGTERM)");
    return;
  }
  const electron = createRequire(import.meta.url)("electron");
  const bundle = join(here, "..", "out", "main", "index.js");
  const cases = [
    { name: "nothing recording", env: {} },
    {
      name: "startup profile recording",
      env: {
        PWRGIT_STARTUP_CPU_PROFILING: "1",
        PWRGIT_STARTUP_CPU_PROFILING_POST_LOAD_MS: "60000",
        PWRGIT_STARTUP_CPU_PROFILING_HARD_TIMEOUT_MS: "60000",
        PWRGIT_STARTUP_CPU_PROFILING_QUIT_ON_COMPLETE: "0",
        PWRGIT_STARTUP_CPU_PROFILING_HEAP_SNAPSHOTS: "0"
      }
    }
  ];
  let failures = 0;
  for (const probe of cases) {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-app-quit-probe-"));
    const fixture = join(root, "forge-fixture.json");
    writeFileSync(fixture, JSON.stringify({ hosts: [], repos: {} }));
    const env = { ...process.env };
    // A sibling Pwr app's shell can leak these and relaunch us through its
    // own Electron (root AGENTS.md).
    for (const key of ["ELECTRON_EXEC_PATH", "ELECTRON_CLI_ARGS", "ELECTRON_MAJOR_VER", "ELECTRON_RUN_AS_NODE"]) {
      delete env[key];
    }
    const run = spawnSync(electron, [fileURLToPath(import.meta.url), "--child"], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...env,
        ...probe.env,
        PWRGIT_PROBE_MAIN_BUNDLE: bundle,
        PWRGIT_USER_DATA_DIR: join(root, "userdata"),
        PWRGIT_GITCONFIG: "/dev/null",
        PWRGIT_E2E_FORGE_FIXTURE: fixture,
        PWRGIT_STARTUP_CPU_PROFILING_DIR: join(root, "diagnostics")
      }
    });
    rmSync(root, { recursive: true, force: true });
    const events = (run.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("PROBE "))
      .map((line) => line.slice("PROBE ".length));
    const quitEvents = events.slice(events.findIndex((e) => e.startsWith("SIGTERM")) + 1);
    const names = quitEvents.map((e) => e.split(" ")[0]);
    const ok =
      events.some((e) => e.startsWith("SIGTERM")) &&
      names.includes("will-quit") &&
      names.at(-1) === "quit" &&
      !names.includes("window-all-closed") &&
      !names.some((name) => name.startsWith("app.exit"));
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${probe.name.padEnd(26)} ${quitEvents.join(", ") || "(no events)"}`);
    if (!ok && run.stderr) console.log(run.stderr.split("\n").slice(-15).join("\n"));
  }
  console.log(failures === 0 ? "Electron finished every quit" : `${failures} quit(s) did not finish`);
  process.exit(failures === 0 ? 0 : 1);
}

async function runChild() {
  const { app, BrowserWindow } = await import("electron");
  let quitAt = 0;
  const say = (message) => {
    const since = quitAt === 0 ? "" : ` +${Date.now() - quitAt}ms`;
    process.stdout.write(`PROBE ${message}${since}\n`);
  };
  for (const method of ["show", "showInactive", "focus", "moveTop", "maximize", "restore"]) {
    BrowserWindow.prototype[method] = function () {};
  }
  app.focus = () => {};
  app.on("ready", () => {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
  });
  // Registered before the app's own listeners, so these see every pass.
  for (const name of ["before-quit", "will-quit", "window-all-closed", "quit"]) {
    app.on(name, () => say(name));
  }
  const exit = app.exit.bind(app);
  app.exit = (code) => {
    say(`app.exit(${code ?? 0})`);
    exit(code);
  };
  let armed = false;
  app.on("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => {
      if (armed) return;
      armed = true;
      setTimeout(() => {
        say(`SIGTERM windows=${BrowserWindow.getAllWindows().length}`);
        quitAt = Date.now();
        process.kill(process.pid, "SIGTERM");
      }, SIGTERM_AFTER_LOAD_MS);
    });
  });
  setTimeout(() => {
    say("timeout");
    exit(3);
  }, 30_000).unref();
  await import(pathToFileURL(process.env.PWRGIT_PROBE_MAIN_BUNDLE).href);
}
