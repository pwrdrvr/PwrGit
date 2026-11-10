import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import { ensureRuntime, inventory, platformPath } from "./electron-runtime-cache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execAsync = promisify(execFile);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = "44.10.1", bytes = randomBytes(1024 * 1024)) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-electron-cache-")));
  roots.push(root);
  const payload = join(root, "payload");
  mkdirSync(join(payload, "Electron.app/Contents/MacOS"), { recursive: true });
  for (const executable of ["Electron.app/Contents/MacOS/Electron", "electron", "electron.exe"]) {
    writeFileSync(join(payload, executable), bytes, { mode: 0o755 });
  }
  writeFileSync(join(payload, "version"), version);
  writeFileSync(join(payload, "electron.d.ts"), "// fixture types\n");
  const zip = join(root, "electron.zip");
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path ${quote(join(payload, "*"))} -DestinationPath ${quote(zip)}`]);
  } else {
    execFileSync("zip", ["-q", "-r", zip, "."], { cwd: payload });
  }
  return { root, zip, version, bytes };
}

function prepareInstall({ root, zip, version }, name, { platform = "darwin", arch = "arm64", env = {}, denyCacheCode, noZipTools = false } = {}) {
  const target = join(root, name);
  const electron = join(target, "node_modules/electron");
  mkdirSync(join(electron, "node_modules/@electron/get"), { recursive: true });
  // Copy the actual entry point so its createRequire resolves our disposable
  // package. No production dependency or user's cache is changed by the test.
  const scripts = join(target, "scripts");
  mkdirSync(scripts);
  cpSync(join(here, "install-electron-binary.mjs"), join(scripts, "install.mjs"));
  const adapter = join(here, "ensure-electron-runtime.mjs");
  if (existsSync(adapter)) cpSync(adapter, join(scripts, "ensure-electron-runtime.mjs"));
  const helper = join(here, "electron-runtime-cache.mjs");
  try { cpSync(helper, join(scripts, "electron-runtime-cache.mjs")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeFileSync(join(electron, "package.json"), JSON.stringify({ name: "electron", version }));
  writeFileSync(join(electron, "checksums.json"), JSON.stringify({
    [`electron-v${version}-${platform}-${arch}.zip`]: hash(readFileSync(zip)),
  }));
  writeFileSync(join(electron, "node_modules/@electron/get/index.js"),
    `exports.downloadArtifact = async (options) => {
      require("fs").appendFileSync(${JSON.stringify(join(root, "requests.jsonl"))}, JSON.stringify(options) + "\\n");
      if (${JSON.stringify(denyCacheCode)} && options.cacheRoot === process.env.electron_config_cache) {
        throw Object.assign(new Error("External ZIP cache is unwritable"), { code: ${JSON.stringify(denyCacheCode)} });
      }
      return ${JSON.stringify(zip)};
    };\n`);
  const installedRequire = createRequire(createRequire(import.meta.url).resolve("electron/package.json"));
  cpSync(installedRequire.resolve("./install.js"), join(electron, "install.js"));
  const bundled = join(electron, "node_modules/@electron-internal/extract-zip");
  mkdirSync(bundled, { recursive: true });
  writeFileSync(join(bundled, "index.js"), `
    if (process.env.PWRGIT_FIXTURE_BLOCK_EXTRACTOR) throw new Error("Extractor must remain lazy");
    exports.extract = async (zip, options) => {
      require("fs").appendFileSync(${JSON.stringify(join(root, "extractions.jsonl"))}, JSON.stringify({ zip, options }) + "\\n");
      return require(${JSON.stringify(installedRequire.resolve("@electron-internal/extract-zip"))}).extract(zip, options);
    };
  `);
  const bootstrap = join(scripts, "bootstrap.mjs");
  writeFileSync(bootstrap, `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const execute = childProcess.execFileSync;
    childProcess.execFileSync = (command, ...args) => {
      if (["unzip", "bsdtar", "powershell.exe", "tar.exe"].includes(command)) {
        throw Object.assign(new Error("Host ZIP tool is unavailable"), { code: "ENOENT" });
      }
      return execute(command, ...args);
    };
    syncBuiltinESMExports();
    await import("./install.mjs");
  `);
  const options = {
    env: { ...process.env, PWRAGENT_HOME: join(root, "home"), npm_config_platform: platform, npm_config_arch: arch, ELECTRON_SKIP_BINARY_DOWNLOAD: "", ELECTRON_INSTALL_PLATFORM: "", ELECTRON_INSTALL_ARCH: "", ...env },
    stdio: "pipe",
  };
  return {
    electron,
    binary: join(electron, "dist", platformPath(platform)),
    run: () => execAsync(process.execPath, [noZipTools ? bootstrap : join(scripts, "install.mjs")], options),
    runSync: () => execFileSync(process.execPath, [noZipTools ? bootstrap : join(scripts, "install.mjs")], options),
    runUpstream: () => execFileSync(process.execPath, [join(electron, "install.js")], options),
  };
}

function installAt(setup, name) {
  const install = prepareInstall(setup, name);
  install.runSync();
  return install.binary;
}

it("regression: explicit linux/x64 overrides conflicting darwin/arm64 npm settings", () => {
  const setup = fixture("44.9.3", randomBytes(8192));
  const env = { ELECTRON_INSTALL_PLATFORM: "linux", ELECTRON_INSTALL_ARCH: "x64",
    npm_config_platform: "darwin", npm_config_arch: "arm64" };
  const upstream = prepareInstall(setup, "upstream", { platform: "linux", arch: "x64", env });
  const install = prepareInstall(setup, "pwrgit", { platform: "linux", arch: "x64", env });
  upstream.runUpstream();
  install.runSync();
  const requests = readFileSync(join(setup.root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(requests.map(({ platform, arch }) => [platform, arch])).toEqual([["linux", "x64"], ["linux", "x64"]]);
  expect(readFileSync(join(install.electron, "path.txt"), "utf8")).toBe("electron");
});

it("property: explicit and npm target precedence agrees with Electron's installer", async () => {
  const setup = fixture("44.9.3", randomBytes(8192));
  let sequence = 0;
  const platform = fc.constantFrom("darwin", "linux", "win32", "mas");
  const arch = fc.constantFrom("x64", "arm64");
  await fc.assert(fc.asyncProperty(fc.record({
    explicitPlatform: fc.option(platform, { nil: "" }), explicitArch: fc.option(arch, { nil: "" }),
    npmPlatform: fc.option(platform, { nil: "" }), npmArch: fc.option(arch, { nil: "" }),
  }), (target) => {
    const expected = { platform: target.explicitPlatform || target.npmPlatform || process.platform,
      arch: target.explicitArch || target.npmArch || process.arch };
    const env = { ELECTRON_INSTALL_PLATFORM: target.explicitPlatform, ELECTRON_INSTALL_ARCH: target.explicitArch,
      npm_config_platform: target.npmPlatform, npm_config_arch: target.npmArch };
    const upstream = prepareInstall(setup, `oracle-${sequence}`, { ...expected, env });
    const install = prepareInstall(setup, `pwrgit-${sequence++}`, { ...expected, env });
    upstream.runUpstream();
    install.runSync();
    const requests = readFileSync(join(setup.root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse).slice(-2);
    expect(requests[1]).toMatchObject({ platform: requests[0].platform, arch: requests[0].arch });
    expect(readFileSync(join(install.electron, "path.txt"), "utf8"))
      .toBe(readFileSync(join(upstream.electron, "path.txt"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(install.electron, ".pwragent-runtime.json"), "utf8"));
    expect(manifest.target).toMatchObject(expected);
    expect(manifest.checksum).toBe(hash(readFileSync(setup.zip)));
  }), { numRuns: 8 });
}, 60_000);

it("regression: real bundled extractor installs without host ZIP tools and stays lazy on cache hits", async () => {
  const setup = fixture("44.9.3", randomBytes(8192));
  const host = { platform: process.platform, arch: process.arch, noZipTools: true };
  const first = prepareInstall(setup, "minimal-host", host);
  first.runSync();
  expect(readFileSync(first.binary)).toEqual(setup.bytes);
  expect(await inventory(join(first.electron, "dist"))).toEqual(await inventory(join(setup.root, "payload")));
  const second = prepareInstall(setup, "cache-hit", { ...host, env: { PWRGIT_FIXTURE_BLOCK_EXTRACTOR: "1" } });
  second.runSync();
  second.runSync();
  expect(readFileSync(second.binary)).toEqual(setup.bytes);
  const extractions = readFileSync(join(setup.root, "extractions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(extractions).toHaveLength(1);
  expect(extractions[0].zip).toBe(setup.zip);
});

it("runs the production entry point for the native host and reuses the same cache across project layouts", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const host = { platform: process.platform, arch: process.arch };
  const installs = ["pwragent/apps/desktop", "pwrgit/app", "pwrsnap/desktop"].map((name) => prepareInstall(setup, name, host));
  const results = await Promise.allSettled(installs.map((install) => install.run()));
  for (const result of results) expect(result.status, result.reason?.stderr).toBe("fulfilled");
  for (const install of installs) expect(readFileSync(install.binary)).toEqual(setup.bytes);
  const cache = join(setup.root, "home/cache/electron-runtime/v1");
  const keys = readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name));
  expect(keys).toHaveLength(1);
  const inodes = installs.map((install) => lstatSync(install.binary).ino);
  expect(new Set(inodes).size).toBe(installs.length);
  for (const install of installs) {
    expect(lstatSync(install.binary).isFile()).toBe(true);
    expect(lstatSync(install.binary).nlink).toBe(1);
  }
  const { identity } = JSON.parse(readFileSync(join(cache, keys[0], "runtime.json"), "utf8"));
  expect(identity).toMatchObject({ version: setup.version, ...host });
  const requests = readFileSync(join(setup.root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(requests).toHaveLength(3);
  for (const request of requests) expect(request).toMatchObject({ version: setup.version, ...host });
}, 60_000);

it.each(["EACCES", "EPERM", "EROFS"])("native entry point forwards owned download paths after %s", (code) => {
  const setup = fixture("44.9.3", randomBytes(8192));
  const host = { platform: process.platform, arch: process.arch };
  const deniedCache = join(setup.root, "external-zip-cache");
  const install = prepareInstall(setup, "worktree/apps/desktop", {
    ...host, denyCacheCode: code,
    env: { electron_config_cache: deniedCache, force_no_cache: "true" },
  });
  install.runSync();
  const requests = readFileSync(join(setup.root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(requests).toHaveLength(2);
  expect(requests[0].cacheRoot).toBe(deniedCache);
  expect(dirname(requests[0].tempDirectory)).toBe(install.electron);
  expect(requests[1].tempDirectory).toBe(requests[0].tempDirectory);
  expect(requests[1].cacheRoot).toBe(join(requests[0].tempDirectory, "cache"));
  for (const request of requests) {
    expect(request).toMatchObject({ ...host, version: setup.version, force: true });
    expect(request.checksums[`electron-v${setup.version}-${host.platform}-${host.arch}.zip`]).toBe(hash(readFileSync(setup.zip)));
  }
  expect(existsSync(requests[0].tempDirectory)).toBe(false);
  expect(readFileSync(install.binary)).toEqual(setup.bytes);
});

it("preserves the missing-Electron skip without downloading", () => {
  const setup = fixture("44.9.3", randomBytes(8192));
  const install = prepareInstall(setup, "production-only");
  rmSync(install.electron, { recursive: true });
  install.runSync();
  expect(existsSync(join(setup.root, "requests.jsonl"))).toBe(false);
});

it("preserves the explicit binary-download skip without touching the shared cache", () => {
  const setup = fixture("44.9.3", randomBytes(8192));
  const install = prepareInstall(setup, "skip", { env: { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" } });
  install.runSync();
  expect(existsSync(install.binary)).toBe(false);
  expect(existsSync(join(setup.root, "home"))).toBe(false);
  expect(existsSync(join(setup.root, "requests.jsonl"))).toBe(false);
});

it.skipIf(process.platform !== "darwin")("APFS oracle: repeated extraction shares blocks with independent writable files", () => {
  const setup = fixture();
  const probe = join(setup.root, "private-size");
  execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
  const first = installAt(setup, "first");
  const second = installAt(setup, "second");
  const metadata = () => execFileSync(probe, [first, second], { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
  expect(hash(readFileSync(first))).toBe(hash(readFileSync(second)));
  const [a, b] = metadata();
  expect(a.inode).not.toBe(b.inode);
  expect(a.cloneId).not.toBe("0");
  expect(a.cloneId).toBe(b.cloneId);
  expect(a.privateBytes + b.privateBytes).toBe(0);
  const original = hash(readFileSync(first));
  writeFileSync(second, randomBytes(1024 * 1024));
  expect(hash(readFileSync(first))).toBe(original);
  expect(metadata()[1].privateBytes).toBeGreaterThan(0);
}, 30_000);

function optionsFor(setup, electronDir = join(setup.root, "package"), overrides = {}) {
  mkdirSync(electronDir, { recursive: true });
  return {
    electronDir, version: setup.version, platform: "darwin", arch: "arm64",
    cacheRoot: join(setup.root, "cache"), expectedChecksum: hash(readFileSync(setup.zip)),
    download: async () => setup.zip, log: () => {}, ...overrides,
  };
}

it("property: cache entries partition every target dimension and archive identity", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.tuple(fc.constantFrom("darwin", "mas", "linux", "win32"), fc.constantFrom("arm64", "x64")), {
      minLength: 2, maxLength: 8, selector: JSON.stringify,
    }),
    async (targets) => {
      const cacheRoot = mkdtempSync(join(setup.root, "partition-"));
      for (const [platform, arch] of targets) {
        const opts = optionsFor(setup, join(cacheRoot, `package-${platform}-${arch}`), { cacheRoot, platform, arch });
        await ensureRuntime(opts);
        expect(readFileSync(join(opts.electronDir, "dist", platformPath(platform)))).toEqual(setup.bytes);
      }
      const manifests = readdirSync(cacheRoot).filter((name) => /^[a-f0-9]{64}$/.test(name))
        .map((name) => {
          const manifest = JSON.parse(readFileSync(join(cacheRoot, name, "runtime.json"), "utf8"));
          expect(Object.keys(manifest.identity)).toEqual(["format", "version", "platform", "arch", "checksum"]);
          expect(manifest.identity.format).toBe(1);
          expect(name).toBe(hash(JSON.stringify(manifest.identity)));
          return manifest;
        });
      expect(manifests.map(({ identity }) => [identity.platform, identity.arch]).sort()).toEqual([...targets].sort());
    },
  ), { numRuns: 6 });
}, 60_000);

it("recovers an OS-confirmed dead installer while concurrent successors preserve the new owner", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const install = prepareInstall(setup, "interrupted");
  const ready = join(setup.root, "owner-ready");
  const script = `
    import { ensureRuntime } from ${JSON.stringify(pathToFileURL(join(here, "electron-runtime-cache.mjs")).href)};
    import { writeFileSync } from "node:fs";
    await ensureRuntime({
      electronDir: ${JSON.stringify(install.electron)}, version: "44.10.1", platform: "darwin", arch: "arm64",
      cacheRoot: ${JSON.stringify(join(setup.root, "home/cache/electron-runtime/v1"))},
      download: async () => {
        writeFileSync(${JSON.stringify(ready)}, "ready");
        await new Promise(() => { setInterval(() => {}, 1000); });
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await setTimeout(20);
    expect(existsSync(ready)).toBe(true); // Witness that the owner actually holds the lock.
    child.kill("SIGKILL");
    await exited; // Process identity, rather than elapsed time, allows recovery.
    const results = await Promise.allSettled([install.run(), install.run(), install.run()]);
    for (const result of results) expect(result.status, result.reason?.stderr).toBe("fulfilled");
    expect(readFileSync(install.binary)).toEqual(setup.bytes);
    expect(existsSync(join(install.electron, ".pwragent-runtime-lock"))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}, 60_000);

it("property: any changed cached payload is rejected and rebuilt from the verified archive", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const mutations = process.platform === "win32" ? ["bytes", "add", "remove"] : ["bytes", "mode", "add", "remove", "link"];
  await fc.assert(fc.asyncProperty(fc.constantFrom(...mutations), fc.uint8Array({ minLength: 1, maxLength: 1024 }), async (kind, data) => {
    const cacheRoot = mkdtempSync(join(setup.root, "tamper-"));
    const a = optionsFor(setup, join(cacheRoot, "a"), { cacheRoot });
    await ensureRuntime(a);
    const key = readdirSync(cacheRoot).find((name) => /^[a-f0-9]{64}$/.test(name));
    const dist = join(cacheRoot, key, "dist");
    const file = join(dist, "Electron.app/Contents/MacOS/Electron");
    if (kind === "bytes") writeFileSync(file, data);
    if (kind === "mode") chmodSync(file, 0o600);
    if (kind === "add") writeFileSync(join(dist, "unexpected"), data);
    if (kind === "remove") rmSync(file);
    if (kind === "link") { rmSync(file); symlinkSync("../../../electron", file); }
    const corrupted = await inventory(dist);
    const b = optionsFor(setup, join(cacheRoot, "b"), { cacheRoot });
    await ensureRuntime(b);
    expect(await inventory(join(b.electronDir, "dist"))).toEqual(await inventory(join(a.electronDir, "dist")));
    expect(await inventory(dist)).toEqual(corrupted); // Preserve corrupt cache for diagnosis.
    expect(lstatSync(join(b.electronDir, "dist/Electron.app/Contents/MacOS/Electron")).isFile()).toBe(true);
  }), { numRuns: 12 });
}, 60_000);

it("revalidates target changes, keeps installed runtimes usable offline, and repairs incomplete installs", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const opts = optionsFor(setup);
  await ensureRuntime(opts);
  const before = lstatSync(join(opts.electronDir, "dist/electron"));
  await ensureRuntime({ ...opts, download: () => { throw new Error("offline"); } });
  expect(lstatSync(join(opts.electronDir, "dist/electron")).ino).toBe(before.ino);
  let downloads = 0;
  await ensureRuntime({ ...opts, arch: "x64", download: async () => { downloads++; return setup.zip; } });
  expect(downloads).toBe(1);
  writeFileSync(join(opts.electronDir, "dist/electron"), "incomplete");
  await ensureRuntime({ ...opts, arch: "x64" });
  expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(setup.bytes);
  expect(readFileSync(join(opts.electronDir, "electron.d.ts"), "utf8")).toBe("// fixture types\n");
  rmSync(join(opts.electronDir, "electron.d.ts"));
  await ensureRuntime({ ...opts, arch: "x64" });
  expect(readFileSync(join(opts.electronDir, "electron.d.ts"), "utf8")).toBe("// fixture types\n");
});

it("separates versions and archive digests, rejecting unverified artifacts without damaging an install", async () => {
  const first = fixture("44.9.3", randomBytes(8192));
  const second = fixture("44.10.1", randomBytes(8192));
  const third = fixture("44.10.1", randomBytes(8192));
  const opts = optionsFor(first);
  await ensureRuntime(opts);
  const before = await inventory(join(opts.electronDir, "dist"));
  await expect(ensureRuntime({ ...opts, version: second.version, download: async () => second.zip })).rejects.toThrow("checksum mismatch");
  expect(await inventory(join(opts.electronDir, "dist"))).toEqual(before);
  await ensureRuntime(optionsFor(second, opts.electronDir, { cacheRoot: opts.cacheRoot }));
  await ensureRuntime(optionsFor(third, opts.electronDir, { cacheRoot: opts.cacheRoot }));
  expect(readFileSync(join(opts.electronDir, "dist/version"), "utf8")).toBe(second.version);
  expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(third.bytes);
  expect(readdirSync(opts.cacheRoot).filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(3);
});

it("uses isolated extraction when the cache is unavailable and releases the lock after errors", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const cacheRoot = join(setup.root, "not-a-directory");
  writeFileSync(cacheRoot, "user data");
  const opts = optionsFor(setup, undefined, { cacheRoot });
  await expect(ensureRuntime({ ...opts, download: () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  expect(existsSync(join(opts.electronDir, ".pwragent-runtime-lock"))).toBe(false);
  await ensureRuntime(opts);
  expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(setup.bytes);
  expect(readFileSync(cacheRoot, "utf8")).toBe("user data");
});

it("property: denied external ZIP-cache writes fall back to owned worktree paths", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  await fc.assert(fc.asyncProperty(fc.constantFrom("EACCES", "EPERM", "EROFS"), async (code) => {
    const electronDir = mkdtempSync(join(setup.root, "restricted-package-"));
    const calls = [];
    const opts = optionsFor(setup, electronDir, {
      download: async (options) => {
        calls.push(options);
        if (calls.length === 1) throw Object.assign(new Error("External ZIP cache is unwritable"), { code });
        return setup.zip;
      },
    });
    await ensureRuntime(opts);
    expect(calls).toHaveLength(2);
    expect(dirname(calls[0].tempDirectory)).toBe(electronDir);
    expect(calls[1].tempDirectory).toBe(calls[0].tempDirectory);
    expect(calls[1].cacheRoot).toBe(join(calls[0].tempDirectory, "cache"));
    expect(existsSync(calls[0].tempDirectory)).toBe(false);
    expect(readFileSync(join(electronDir, "dist/electron"))).toEqual(setup.bytes);
  }), { numRuns: 6 });
}, 60_000);

it("does not retry network failures as cache permission failures", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const calls = [];
  const opts = optionsFor(setup, undefined, {
    download: async (options) => {
      calls.push(options);
      throw Object.assign(new Error("Network failed"), { code: "ECONNRESET" });
    },
  });
  await expect(ensureRuntime(opts)).rejects.toThrow("Network failed");
  expect(calls).toHaveLength(1);
  expect(existsSync(calls[0].tempDirectory)).toBe(false);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("real @electron/get installs with both external caches write-denied", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const require = createRequire(import.meta.url);
  const { downloadArtifact } = createRequire(require.resolve("electron/package.json"))("@electron/get");
  const zipCache = join(setup.root, "external-zip-cache");
  const extractionCache = join(setup.root, "external-extraction-cache");
  for (const path of [zipCache, extractionCache]) { mkdirSync(path); chmodSync(path, 0o555); }
  const denied = [];
  const calls = [];
  const opts = optionsFor(setup, join(setup.root, "worktree/node_modules/electron"), {
    cacheRoot: extractionCache,
    download: async (options) => {
      calls.push(options);
      try {
        return await downloadArtifact({
          version: setup.version, artifactName: "electron", platform: "darwin", arch: "arm64",
          checksums: { [`electron-v${setup.version}-darwin-arm64.zip`]: hash(readFileSync(setup.zip)) },
          cacheRoot: zipCache,
          // Real checksum/cache handling; replace only HTTP with a local ZIP.
          downloader: { download: async (_url, destination) => { copyFileSync(setup.zip, destination); } },
          ...options,
        });
      } catch (error) { denied.push(error.code); throw error; }
    },
  });
  try {
    await ensureRuntime(opts);
    expect(denied).toEqual(["EACCES"]);
    expect(calls).toHaveLength(2);
    expect(dirname(calls[0].tempDirectory)).toBe(opts.electronDir);
    expect(calls[1].cacheRoot).toBe(join(calls[0].tempDirectory, "cache"));
    expect(existsSync(calls[0].tempDirectory)).toBe(false);
    expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(setup.bytes);
    expect(readdirSync(zipCache)).toEqual([]);
    expect(readdirSync(extractionCache)).toEqual([]);
  } finally {
    for (const path of [zipCache, extractionCache]) chmodSync(path, 0o755);
  }
}, 30_000);

it("releases the package lock even when staging cleanup is denied", () => {
  const setup = fixture("44.9.3", randomBytes(8192));
  const opts = optionsFor(setup);
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const remove = fs.rmSync;
    fs.rmSync = (path, options) => {
      if (String(path).includes(".runtime-install-")) {
        throw Object.assign(new Error("Staging cleanup denied"), { code: "EACCES" });
      }
      return remove(path, options);
    };
    syncBuiltinESMExports();
    const { ensureRuntime } = await import(${JSON.stringify(pathToFileURL(join(here, "electron-runtime-cache.mjs")).href)});
    await assert.rejects(ensureRuntime({
      ...${JSON.stringify(opts)}, download: async () => ${JSON.stringify(setup.zip)}, log: () => {},
    }), /Staging cleanup denied/);
    assert.equal(fs.existsSync(${JSON.stringify(join(opts.electronDir, ".pwragent-runtime-lock"))}), false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});

it("concurrent processes publish one shared cache and serialize writes to the same package", async () => {
  const setup = fixture();
  const installs = ["one", "two", "three"].map((name) => prepareInstall(setup, name));
  const results = await Promise.allSettled([...installs.map((install) => install.run()), installs[0].run(), installs[0].run()]);
  for (const result of results) expect(result.status, result.reason?.stderr).toBe("fulfilled");
  for (const install of installs) {
    expect(readFileSync(install.binary)).toEqual(setup.bytes);
    expect(existsSync(join(install.electron, ".pwragent-runtime-lock"))).toBe(false);
  }
  const requests = readFileSync(join(setup.root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(requests).toHaveLength(3);
  expect(requests.every((request) => request.version === setup.version && request.platform === "darwin" && request.arch === "arm64")).toBe(true);
  if (process.platform === "darwin") {
    const probe = join(setup.root, "private-size");
    execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
    const metadata = execFileSync(probe, installs.map((install) => install.binary), { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
    expect(new Set(metadata.map(({ inode }) => inode)).size).toBe(3);
    expect(new Set(metadata.map(({ cloneId }) => cloneId)).size).toBe(1);
    expect(metadata.reduce((sum, { privateBytes }) => sum + privateBytes, 0)).toBe(0);
  }
}, 60_000);
