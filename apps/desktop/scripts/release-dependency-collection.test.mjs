import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const source = readFileSync(join(import.meta.dirname, "release.mjs"), "utf8");
const desktopRequire = createRequire(join(desktopRoot, "package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
const { determinePackageManagerEnv } = builderRequire("app-builder-lib/out/node-module-collector/index.js");
const { collectNodeModulesWithLogging } = builderRequire("app-builder-lib/out/util/appFileCopier.js");
const { getConfig, validateConfiguration } = builderRequire("app-builder-lib/out/util/config/config.js");
const { DebugLogger, TmpDir } = builderRequire("builder-util");

// Exercise the orchestrator's helper without executing its top-level build or
// touching signing credentials. The collection below uses the installed,
// pinned electron-builder, not a reimplementation of its dependency walk.
function configureStage(stageDir, platform = process.platform, version = "11.14.1\n") {
  const calls = [];
  const start = source.indexOf("function configureStagePackageManager()");
  const end = source.indexOf("\nfunction findWindowsUnpackedDir", start);
  const configure = runInNewContext(`${source.slice(start, end)}\nconfigureStagePackageManager`, {
    stageDir, join, readFileSync, writeFileSync, process: { platform },
    runQuiet: (...args) => { calls.push(args); return version; },
  });
  configure();
  return calls;
}

function writePackage(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
}

test("the real electron-builder schema accepts the release configuration", async () => {
  const config = await getConfig(desktopRoot);
  await validateConfiguration(config, new DebugLogger());
  expect(config.npmRebuild).toBe(false);
  expect(config.mac.notarize).toBe(true);
  expect(config.win.signAndEditExecutable).toBe(true);
});

test.each(["darwin", "win32"])("selects npm only in the prepared manifest (%s)", (platform) => {
  const cache = join(repoRoot, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const stageDir = mkdtempSync(join(cache, "release-manager-"));
  try {
    const manifest = { name: "fixture", version: "1.0.0", dependencies: { runtime: "1.0.0" } };
    writePackage(stageDir, manifest);
    const calls = configureStage(stageDir, platform);
    expect(calls).toEqual([[platform === "win32" ? "npm.cmd" : "npm", ["--version"], { shell: platform === "win32" }]]);
    expect(JSON.parse(readFileSync(join(stageDir, "package.json"), "utf8"))).toEqual({ ...manifest, packageManager: "npm@11.14.1" });
    expect(() => configureStage(stageDir, platform, "unexpected output")).toThrow("unexpected npm version");
    // The helper is called after deploy, inside the preparation-only block;
    // sign-stage-only neither installs anything nor regenerates the manifest.
    const preparation = source.slice(source.indexOf("if (!signStageOnly) {"), source.indexOf("} else if (!existsSync(stageDir))"));
    expect(preparation.indexOf("configureStagePackageManager();")).toBeGreaterThan(preparation.indexOf('runChecked("pnpm", deployArgs'));
    expect(source.match(/configureStagePackageManager\(\);/g)).toHaveLength(1);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
});

test.each(["hoisted", "isolated"])("collects the installed production graph from the %s signing stage", async (layout) => {
  const cache = join(repoRoot, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const fixtureRoot = mkdtempSync(join(cache, "release-collection-"));
  const stageDir = join(fixtureRoot, "apps", "desktop", "release-stage");
  const tmpDir = new TmpDir();
  try {
    // macOS archives include this pnpm workspace manifest; Windows carries a
    // hoisted deployment and its pnpm lock. Both must select the staged npm
    // collector regardless of those files or pnpm's inherited environment.
    writePackage(fixtureRoot, { name: "workspace", packageManager: "pnpm@12.8.1" });
    const manifest = {
      name: "release-fixture", version: "1.0.0", packageManager: "pnpm@12.8.1",
      dependencies: { runtime: "1.0.0", alias: "npm:actual-name@1.0.0" },
      devDependencies: { "builder-only": "1.0.0" },
    };
    writePackage(stageDir, manifest);
    writeFileSync(join(stageDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const lifecycleMarker = join(stageDir, "lifecycle-ran");
    const runtime = { name: "runtime", version: "1.0.0", dependencies: { transitive: "1.0.0" },
      optionalDependencies: { "not-installed": "1.0.0" },
      scripts: { postinstall: "node postinstall.cjs" } };
    const runtimeDir = layout === "hoisted"
      ? join(stageDir, "node_modules", "runtime")
      : join(stageDir, "node_modules", ".pnpm", "runtime@1.0.0", "node_modules", "runtime");
    writePackage(runtimeDir, runtime);
    writeFileSync(join(runtimeDir, "postinstall.cjs"), `require('fs').writeFileSync(${JSON.stringify(lifecycleMarker)}, 'ran');\n`);
    const transitiveDir = layout === "hoisted"
      ? join(runtimeDir, "node_modules", "transitive")
      : join(runtimeDir, "..", "transitive");
    writePackage(transitiveDir, { name: "transitive", version: "1.0.0" });
    if (layout === "isolated") symlinkSync(runtimeDir, join(stageDir, "node_modules", "runtime"), "junction");
    writePackage(join(stageDir, "node_modules", "alias"), { name: "actual-name", version: "1.0.0" });
    writePackage(join(stageDir, "node_modules", "builder-only"), { name: "builder-only", version: "1.0.0" });
    configureStage(stageDir);
    const manager = await determinePackageManagerEnv({ projectDir: stageDir, appDir: stageDir }).value;
    expect(manager.pm).toBe("npm");
    expect(await manager.workspaceRoot).toBe(stageDir);
    const nodeModules = await collectNodeModulesWithLogging({ info: {
      appDir: stageDir, projectDir: stageDir, tempDirManager: tmpDir,
      getWorkspaceRoot: () => manager.workspaceRoot,
      getPackageManager: () => manager.pm,
      nodePackageName: manifest.name, originalMetadata: manifest,
      config: { allowMissingDependencies: false },
    } });
    const flatten = (modules) => modules.flatMap((module) => [module.name, ...flatten(module.dependencies ?? [])]);
    expect(flatten(nodeModules).sort()).toEqual(["alias", "runtime", "transitive"]);
    expect(() => readFileSync(lifecycleMarker)).toThrow();
  } finally {
    await tmpDir.cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
