// A bare Electron main for harness pages: one window, never shown, loading
// the built page named by PWRGIT_HARNESS_HTML. Hidden, so a run on a
// developer's machine takes no focus and draws nothing on their desktop;
// layout, fonts and ResizeObserver all still run.
const { app, BrowserWindow } = require("electron");

// No Dock icon or menu bar, and so no activation: the harness never takes
// focus from whatever the developer is doing.
if (process.platform === "darwin") app.setActivationPolicy("accessory");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: Number(process.env.PWRGIT_HARNESS_WIDTH || 1280),
    height: Number(process.env.PWRGIT_HARNESS_HEIGHT || 900),
    webPreferences: {
      // A hidden window's timers and frames are throttled by default.
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  void win.loadFile(process.env.PWRGIT_HARNESS_HTML);
});
