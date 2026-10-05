#!/usr/bin/env node
// Runs only on disposable native Linux CI runners under Xvfb. Drive the
// installed, fused executable through renderer CDP, without Node inspection
// flags or disabling Electron's sandbox. All app data is temporary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { chromium } from "@playwright/test";

if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Smoke test requires an unprivileged Linux user");
const [version, output = "linux-smoke"] = process.argv.slice(2);
if (!version) throw new Error("Usage: linux-installed-smoke.mjs <version> [output-dir]");
const sandbox = statSync("/opt/PwrGit/chrome-sandbox");
assert.equal(sandbox.uid, 0, "Installed sandbox must be owned by root");
mkdirSync(resolve(output), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "pwrgit-installed-smoke-"));
const env = { ...process.env, PWRGIT_USER_DATA_DIR: root };
for (const key of ["ELECTRON_EXEC_PATH", "ELECTRON_CLI_ARGS", "ELECTRON_MAJOR_VER", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[key];
const child = spawn("/opt/PwrGit/pwrgit", ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
const exited = once(child, "exit");
let logs = "";
let browser;
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Installed app did not start within 45 seconds:\n${logs}`)), 45_000);
    const inspect = bytes => {
      logs += bytes.toString();
      const match = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Installed app exited ${code}: ${logs}`)); });
  });
  browser = await chromium.connectOverCDP(endpoint);
  let page;
  const deadline = Date.now() + 45_000;
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith("file:"));
    if (!page) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.ok(page, "Installed app did not open its renderer");
  await page.waitForFunction(() => !!window.pwrgit?.dispatch);
  const evidence = await page.evaluate(async () => {
    const [identity, profiles, git, status] = await Promise.all([
      window.pwrgit.dispatch("app:readIdentity"), window.pwrgit.dispatch("profile:list"),
      window.pwrgit.dispatch("git:runtimeStatus"), window.pwrgit.dispatch("app:readUpdateStatus")
    ]);
    return { identity, profiles, git, status };
  });
  assert.equal(evidence.identity.ok, true);
  assert.equal(evidence.identity.value.version, version);
  assert.equal(evidence.identity.value.buildType, "packaged");
  assert.equal(evidence.identity.value.platform.arch, process.arch);
  assert.equal(evidence.profiles.ok, true, "SQLite-backed profile read failed");
  assert.ok(statSync(join(root, "pwrgit.db")).size > 0, "Packaged SQLite did not create a database");
  assert.equal(evidence.git.ok, true);
  assert.equal(evidence.git.value.active, "bundled");
  const bundled = evidence.git.value.candidates.find(candidate => candidate.source === "bundled");
  assert.ok(bundled?.git && bundled?.lfs && bundled.problem === null, "Packaged Git/LFS did not execute");
  assert.notEqual(evidence.status.value?.status, "skipped", "Installed DEB backend was gated off");
  writeFileSync(resolve(output, "runtime.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await page.screenshot({ path: resolve(output, "installed.png") });
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const [code, signal] = await exited;
  clearTimeout(timeout);
  assert.equal(code, 0, `Installed app failed graceful shutdown (${signal}): ${logs}`);
  console.log(`Installed Linux ${process.arch} app: renderer, SQLite, bundled Git/LFS, updater backend and graceful quit passed`);
} finally {
  child.kill("SIGKILL");
  if (browser) await browser.close().catch(() => {});
  writeFileSync(resolve(output, "runtime.log"), logs);
  rmSync(root, { recursive: true, force: true });
}
