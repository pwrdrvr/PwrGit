import { app } from "electron";
import {
  inferUpdateSelection,
  ok,
  type AppIdentity,
  type UpdatesSettings
} from "@pwrgit/shared";
import desktopPackage from "../../package.json";
import type { CommandBus } from "./command-bus";

type AppIdentityInput = {
  name: string;
  version: string;
  packaged: boolean;
  platform: NodeJS.Platform | string;
  platformVersion: string;
  arch: string;
  electronVersion: string;
};

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux"
};

function releaseLabel(release: UpdatesSettings): string {
  const train = release.train === "stable" ? "Stable" : "Beta";
  const track = release.channel === "latest" ? "Latest" : "Prerelease";
  return `${train} / ${track}`;
}

/**
 * A built-entry development launch points Electron at `out/main`, not at the
 * desktop package, so Electron falls back to its own runtime version. The
 * package import is bundled into main and remains the authoritative product
 * version in that mode; packaged apps use their signed bundle metadata.
 */
export function resolvePwrGitVersion(
  packaged: boolean,
  runtimeVersion: string
): string {
  return packaged ? runtimeVersion : desktopPackage.version;
}

/** Pure builder keeps formatting stable across the UI, clipboard, and tests. */
export function createAppIdentity(input: AppIdentityInput): AppIdentity {
  const release = inferUpdateSelection(input.version);
  const platformName = PLATFORM_NAMES[input.platform] ?? input.platform;
  const buildType = input.packaged ? "packaged" : "development";
  const identity: AppIdentity = {
    name: input.name,
    version: input.version,
    release,
    buildType,
    platform: {
      name: platformName,
      version: input.platformVersion,
      arch: input.arch
    },
    electronVersion: input.electronVersion,
    diagnosticsText: ""
  };

  identity.diagnosticsText = [
    `${identity.name} ${identity.version}`,
    `Release: ${releaseLabel(identity.release)}`,
    `Build: ${identity.buildType === "packaged" ? "Packaged" : "Development"}`,
    `Platform: ${identity.platform.name} ${identity.platform.version} (${identity.platform.arch})`,
    `Electron: ${identity.electronVersion}`
  ].join("\n");
  return identity;
}

export function readAppIdentity(): AppIdentity {
  return createAppIdentity({
    name: app.getName(),
    version: resolvePwrGitVersion(app.isPackaged, app.getVersion()),
    packaged: app.isPackaged,
    platform: process.platform,
    platformVersion: process.getSystemVersion(),
    arch: process.arch,
    electronVersion: process.versions.electron ?? "unknown"
  });
}

export function registerAppIdentityHandlers(
  bus: CommandBus,
  readIdentity: () => AppIdentity = readAppIdentity
): void {
  bus.register("app:readIdentity", () => ok(readIdentity()));
}
