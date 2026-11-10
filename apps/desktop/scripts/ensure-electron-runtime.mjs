import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureRuntime } from "./electron-runtime-cache.mjs";

const require = createRequire(import.meta.url);
let electronPackageJsonPath;
try {
  electronPackageJsonPath = require.resolve("electron/package.json");
} catch {
  // Production deployments omit this devDependency; the packager fetches its own runtime.
  console.log("electron is not installed here; skipping the Electron binary download.");
  process.exit(0);
}
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log("ELECTRON_SKIP_BINARY_DOWNLOAD is set; skipping the Electron binary download.");
  process.exit(0);
}
const electronRequire = createRequire(electronPackageJsonPath);
const { downloadArtifact } = electronRequire("@electron/get");
const { version } = electronRequire("./package.json");
const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;
const checksums = process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
  ? undefined
  : electronRequire("./checksums.json");

await ensureRuntime({
  electronDir: dirname(electronPackageJsonPath),
  version, platform, arch,
  cacheRoot: join(process.env.PWRAGENT_HOME || join(homedir(), ".pwragent"), "cache/electron-runtime/v1"),
  expectedChecksum: checksums?.[`electron-v${version}-${platform}-${arch}.zip`],
  // Keep Electron's native extractor lazy: cache hits and working host tools
  // must remain usable even when an OS policy blocks the native binding.
  extractFallback: (zipPath, targetDir) => electronRequire("@electron-internal/extract-zip").extract(zipPath, { dir: targetDir }),
  download: (options) => downloadArtifact({
    version,
    artifactName: "electron",
    force: process.env.force_no_cache === "true",
    cacheRoot: process.env.electron_config_cache,
    checksums, platform, arch,
    ...options,
  }),
});
