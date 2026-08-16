import { BrowserWindow, ipcMain, Menu } from "electron";
import {
  APP_MENU_MODEL_CHANNEL,
  APP_MENU_POPUP_CHANNEL,
  type AppMenuTopLevel
} from "@pwrgit/shared";

/**
 * Bridge the Windows renderer-painted top-level menu to Electron's real menu.
 * `titleBarStyle: "hidden"` reclaims the title bar but also removes the native
 * File/Edit/etc. row. The renderer owns only those labels; native submenus,
 * roles, accelerators, enabled state, and click handlers remain here in main.
 */
function appMenuTopLevel(): AppMenuTopLevel[] {
  const menu = Menu.getApplicationMenu();
  if (menu === null) return [];

  const items: AppMenuTopLevel[] = [];
  menu.items.forEach((item, index) => {
    if (item.role === "appMenu") return;
    if (item.visible === false) return;
    if (typeof item.label !== "string" || item.label.length === 0) return;
    if (item.submenu === undefined) return;
    items.push({ index, label: item.label });
  });
  return items;
}

let wired = false;

/** Register once; handlers read the live application menu on every request. */
export function wireAppMenuBridge(): void {
  if (wired) return;
  wired = true;

  ipcMain.handle(APP_MENU_MODEL_CHANNEL, () => appMenuTopLevel());

  ipcMain.on(APP_MENU_POPUP_CHANNEL, (event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    const { index, x, y } = payload as {
      index?: unknown;
      x?: unknown;
      y?: unknown;
    };
    if (typeof index !== "number") return;

    const submenu = Menu.getApplicationMenu()?.items[index]?.submenu;
    if (submenu === undefined) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return;

    const options: Electron.PopupOptions = { window };
    if (typeof x === "number" && Number.isFinite(x)) options.x = Math.round(x);
    if (typeof y === "number" && Number.isFinite(y)) options.y = Math.round(y);
    submenu.popup(options);
  });
}
