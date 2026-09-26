/**
 * Download the Electron binary that `pnpm dev`, `electron-vite preview` and the
 * Playwright E2E suite launch.
 *
 * Through Electron 41 the `electron` package fetched its binary from its own
 * postinstall. Electron 42 dropped that script: the package now downloads on
 * the first `require("electron")`, or when its `install-electron` bin runs.
 * Nothing in this repo requires it early enough on its own:
 *
 *   - electron-vite reads the package's path.txt directly and fails `pnpm dev`
 *     with "Electron uninstall" when the binary was never fetched;
 *   - Playwright's `_electron.launch` would fetch it inside a test worker, where
 *     `--fully-parallel` workers race to extract into the same dist/;
 *   - scripts/linux-sandbox.mjs inspects dist/chrome-sandbox right after this.
 *
 * So postinstall fetches it up front, as Electron itself used to. install.js
 * exits at once when the matching binary is already in place, so a repeat
 * `pnpm i` costs nothing. Electron 42 stopped reading
 * ELECTRON_SKIP_BINARY_DOWNLOAD along with its script; this one still honors
 * it, so an environment that set it to skip the download keeps skipping it.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let electronDir;
try {
  electronDir = dirname(require.resolve("electron/package.json", { paths: [desktopRoot] }));
} catch {
  // A production dependency tree (`pnpm deploy --prod`) has no Electron;
  // electron-builder downloads the runtime it packages by itself.
  console.log("electron is not installed here; skipping the Electron binary download.");
  process.exit(0);
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log("ELECTRON_SKIP_BINARY_DOWNLOAD is set; skipping the Electron binary download.");
  process.exit(0);
}

const result = spawnSync(process.execPath, [join(electronDir, "install.js")], {
  cwd: electronDir,
  stdio: "inherit"
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  console.error(`Electron's install.js exited with ${result.status ?? result.signal}.`);
  process.exit(result.status ?? 1);
}
