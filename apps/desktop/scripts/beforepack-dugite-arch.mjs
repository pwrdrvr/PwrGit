#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageBetterSqlite3 } from "./stage-better-sqlite3-arch.mjs";
import { stageRuntime } from "./stage-runtime.mjs";

const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

export default async function beforePack(context) {
  const arch = ARCH_NAMES[context.arch];
  if (arch !== "x64" && arch !== "arm64") return;
  const appDir = context.packager?.info?.appDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const platform = context.electronPlatformName;
  stageBetterSqlite3({ appDir, platform, arch });
  if (platform === "win32") return;
  if (platform !== process.platform) throw new Error("Custom Git packaging requires a host matching the target platform.");
  await stageRuntime({ manifestPath: join(appDir, "custom-git-runtime.json"), platform, arch,
    output: join(appDir, "node_modules", "dugite", "git"), cache: process.env.PWRGIT_RUNTIME_CACHE });
}
