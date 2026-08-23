import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  APPEARANCE_THEME_DEFAULT,
  APP_MENU_MODEL_CHANNEL,
  APP_MENU_POPUP_CHANNEL,
  IPC_DISPATCH_CHANNEL,
  IPC_EVENT_CHANNEL,
  type AppMenuPopupRequest,
  parseAppearanceArg,
  type AppAppearance,
  type AppMenuTopLevel
} from "@pwrgit/shared";

// Each window is bound to one profile, passed by the main process via
// additionalArguments when the window is created.
const profileArg = process.argv.find((a) => a.startsWith("--pwrgit-profile="));
const bootstrapAppearance: AppAppearance = parseAppearanceArg(process.argv) ?? {
  theme: APPEARANCE_THEME_DEFAULT,
  resolvedTheme: "dark"
};

// Playwright can ask the preload bridge to fail selected boot reads once. The
// allowlist keeps this seam read-only and makes retry recovery deterministic.
const injectableBootReads = new Set(["profile:list", "repo:list", "forge:status"]);
const failOnce = new Set(
  (process.env["PWRGIT_E2E_FAIL_READ_ONCE"] ?? "")
    .split(",")
    .filter((name) => injectableBootReads.has(name))
);

// The minimal, typed-at-the-renderer surface. Renderer-side helpers in
// src/renderer/src/lib/pwrgit.ts add the command/event generics on top.
const api = {
  profileId: profileArg?.slice("--pwrgit-profile=".length) ?? null,
  platform: process.platform,
  appearance: bootstrapAppearance,

  dispatch: (name: string, req: unknown): Promise<unknown> => {
    if (failOnce.delete(name)) {
      return Promise.resolve({
        ok: false,
        error: {
          kind: "unknown",
          code: "e2e_injected_read_failure",
          message: "The local service did not answer this read."
        }
      });
    }
    return ipcRenderer.invoke(IPC_DISPATCH_CHANNEL, name, req);
  },

  on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      eventChannel: string,
      payload: unknown
    ): void => {
      if (eventChannel === channel) handler(payload);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener);
    return () => ipcRenderer.off(IPC_EVENT_CHANNEL, listener);
  },

  getAppMenuModel: (): Promise<AppMenuTopLevel[]> =>
    ipcRenderer.invoke(APP_MENU_MODEL_CHANNEL) as Promise<AppMenuTopLevel[]>,

  popupAppMenu: (payload: AppMenuPopupRequest): void =>
    ipcRenderer.send(APP_MENU_POPUP_CHANNEL, payload)
};

contextBridge.exposeInMainWorld("pwrgit", api);
