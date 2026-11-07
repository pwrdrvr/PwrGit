import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";

export function resolveMcpExecutable(roots: { isPackaged: boolean; resourcesPath: string; appPath: string; platform: string }): string {
  const name = roots.platform === "win32" ? "pwrgit-mcp.exe" : "pwrgit-mcp";
  if (roots.isPackaged) return join(roots.resourcesPath, name);
  // E2E/direct built-entry launches set appPath to out/main; dev sets the
  // desktop package root. Locate the workspace instead of assuming a depth.
  for (let directory = resolve(roots.appPath); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "pnpm-workspace.yaml")))
      return join(directory, "apps", "desktop", "build", "mcp", name);
    if (dirname(directory) === directory) throw new Error("Cannot locate this PwrGit checkout; rebuild and copy its current native MCP command");
  }
}
/** The host launches only this signed transport executable, never Electron. */
export function mcpExecutablePath(): string {
  return resolveMcpExecutable({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, platform: process.platform });
}
