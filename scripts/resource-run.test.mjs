import { randomUUID } from "node:crypto";
import { DESCENDANT_ENV, ownerRunning } from "./lib/tool-processes.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { isAncestorPid, MACHINE_TOOL_LOCK, OWNER_ENV, processStartedAt } from "./resource-run.mjs";

const directories = [];
const children = new Set();
const runner = new URL("./resource-run.mjs", import.meta.url).href;

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pwrgit-resource-"));
  directories.push(directory);
  const driver = path.join(directory, "driver.mjs");
  await writeFile(driver, `
    import { runResourceCommand } from ${JSON.stringify(runner)};
    const spec = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());
    try {
      const result = await runResourceCommand(spec.command ?? process.execPath, spec.args, {
        policy: { constrained: spec.high !== true, effectiveMemory: 12 * 1024 ** 3 },
        lockPath: spec.lockPath, cwd: spec.cwd, env: process.env,
      });
      if (result.signal) { setTimeout(()=>process.exit(1),1000); process.kill(process.pid, result.signal); }
      else process.exitCode = result.code ?? 1;
    } catch (error) { console.error(error); process.exitCode = 1; }
  `);
  return { directory, driver, lockPath: path.join(directory, "lane") };
}

function launch(f, spec, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv[OWNER_ENV]; // Never contend with the real outer test lease.
  if (env[OWNER_ENV]) childEnv[OWNER_ENV] = env[OWNER_ENV];
  const child = spawn(process.execPath, [f.driver, encode({ lockPath: f.lockPath, cwd: f.directory, ...spec })], {
    env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, completed };
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64"); }
function evalArgs(code) { return ["-e", code]; }

async function nodeHeapBaseline(f) {
  const result = await launch(f, { high: true, args: ["--max-old-space-size=2048", "-e", "console.log(require('v8').getHeapStatistics().heap_size_limit)"] }, { NODE_OPTIONS: "" }).completed;
  expect(result.code, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

async function waitFor(file) {
  for (let i = 0; i < 300; i++) {
    try { return await readFile(file, "utf8"); } catch { await delay(50); }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function processRunning(pid) {
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch { return false; }
}

afterEach(async () => {
  await Promise.all([...children].map((child) => {
    const done = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    return done;
  }));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("shared resource lease", () => {
  it("anchors the cross-project lane in the OS user's home, independent of TMPDIR", () => {
    expect(MACHINE_TOOL_LOCK).toMatch(/\.cache[/\\]pwragent-tools-[a-f0-9]{16}[/\\]heavy-tool$/);
    expect(isAncestorPid(10, 30, (pid) => ({ 30: 20, 20: 10, 10: 1 })[pid])).toBe(true);
    expect(isAncestorPid(99, 30, (pid) => ({ 30: 20, 20: 30 })[pid])).toBe(false);
  });

  it("preserves the complete environment, arguments, and exit status on large machines", async () => {
    const f = await fixture();
    const args = ["--max-old-space-size=6144", "-e", "console.log(JSON.stringify({env:process.env.NODE_OPTIONS,argv:process.argv.slice(1)})); process.exitCode=7", "--", "x y"];
    const result = await launch(f, { high: true, args }, { NODE_OPTIONS: "--max-old-space-size=6144 --trace-warnings" }).completed;
    expect(result.code).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ env: "--max-old-space-size=6144 --trace-warnings", argv: ["x y"] });
    expect(result.stderr).toBe("");
    await expect(stat(`${f.lockPath}.lock`)).rejects.toThrow();
    await expect(stat(`${f.lockPath}.owner.json`)).rejects.toThrow();
  });

  it("caps actual Node CLI and inherited percentage overrides while preserving warnings", async () => {
    const f = await fixture();
    const result = await launch(f, { args: ["--max-old-space-size=6144", "--max-old-space-size-percentage=90", "-e", "console.log(JSON.stringify({options:process.env.NODE_OPTIONS,heap:require('v8').getHeapStatistics().heap_size_limit}))"] },
      { NODE_OPTIONS: "--trace-warnings --max_old_space_size=6144 --max-old-space-size-percentage=90" }).completed;
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.options).toBe("--trace-warnings --max-old-space-size=2048");
    // V8 includes young generation on top of the configured old space.
    expect(data.heap).toBe(await nodeHeapBaseline(f));
  });

  it("preserves a working preload whose path contains spaces while enforcing the cap", async () => {
    const f = await fixture();
    const preload = path.join(f.directory, "preload with spaces.cjs");
    await writeFile(preload, "globalThis.fixturePreloaded=true;");
    const preloadOption = `--require "${preload.replace(/\\/g, "/")}"`;
    const result = await launch(f, { args: evalArgs("console.log(JSON.stringify({loaded:globalThis.fixturePreloaded,options:process.env.NODE_OPTIONS,heap:require('v8').getHeapStatistics().heap_size_limit}))") }, {
      NODE_OPTIONS: `${preloadOption} --max-old-space-size=6144 --max-old-space-size-percentage=90`,
    }).completed;
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.loaded).toBe(true);
    expect(data.options).toBe(`${preloadOption} --max-old-space-size=2048`);
    expect(data.heap).toBe(await nodeHeapBaseline(f));
  });

  it.each(["-e", "--eval", "-p", "--print", "-pe"])("caps actual late heap flags after %s without rewriting option operands or application arguments", async (evalFlag) => {
    const f = await fixture();
    const expression = "JSON.stringify({heap:require('v8').getHeapStatistics().heap_size_limit,argv:process.argv.slice(1),title:process.title})";
    const code = ["-e", "--eval"].includes(evalFlag) ? `console.log(${expression})` : expression;
    const result = await launch(f, { args: ["--title=--max-old-space-size=6144", evalFlag, code, "--max-old-space-size=6144", "--max-old-space-size-percentage", "90", "--", "--max-old-space-size=777"] }, { NODE_OPTIONS: "--trace-warnings --max-old-space-size=6144" }).completed;
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.heap).toBe(await nodeHeapBaseline(f));
    expect(data.argv).toEqual(["--max-old-space-size=777"]);
    expect(data.title).toBe("--max-old-space-size=6144");
  }, 30_000);

  it("preserves Node's diagnostic for a flag-shaped pair-form title value", async () => {
    const f = await fixture();
    const result = await launch(f, { args: ["--title", "--max-old-space-size=6144", "-e", "process.exitCode=0"] }).completed;
    expect(result.code).toBe(9);
    expect(result.stderr).toContain("--title requires an argument");
  }, 30_000);

  it("caps late flags after an equals-form eval and preserves flags after a positional application argument", async () => {
    const f = await fixture();
    const code = "console.log(JSON.stringify({heap:require('v8').getHeapStatistics().heap_size_limit,argv:process.argv.slice(1)}))";
    const result = await launch(f, { args: [`--eval=${code}`, "--max-old-space-size=6144", "application-arg", "--max-old-space-size=777"] }).completed;
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.heap).toBe(await nodeHeapBaseline(f));
    expect(data.argv).toEqual(["application-arg", "--max-old-space-size=777"]);
  }, 30_000);

  // Native Windows shim parsing is verified separately from Node's argv.
  it.skipIf(process.platform !== "win32")("preserves .cmd argv on a larger machine without acquiring a lease", async () => {
    const f = await fixture();
    const bin = path.join(f.directory, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const entry = path.join(f.directory, "echo.cjs");
    const shim = path.join(bin, "fixture.cmd");
    await writeFile(entry, "console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=7;");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
    const args = ["two words", 'quotes "inside" & pipes | safe', "C:\\ending\\"];
    const result = await launch(f, { high: true, command: shim, args }).completed;
    expect(result.code, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual(args);
    await expect(stat(`${f.lockPath}.lock`)).rejects.toThrow();
  }, 30_000);

  it("serializes separate processes in separate worktrees", async () => {
    const f = await fixture();
    const events = path.join(f.directory, "events");
    const cwd1 = path.join(f.directory, "worktree-a");
    const cwd2 = path.join(f.directory, "worktree-b");
    await mkdir(cwd1); await mkdir(cwd2);
    const task = (id) => evalArgs(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(events)}, '${id}:start\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(events)}, '${id}:end\\n'),200)`);
    const a = launch(f, { cwd: cwd1, args: task("a") });
    const b = launch(f, { cwd: cwd2, args: task("b") });
    expect((await Promise.all([a.completed, b.completed])).map((r) => r.code)).toEqual([0, 0]);
    const rows = (await readFile(events, "utf8")).trim().split("\n");
    expect(rows).toEqual(rows[0] === "a:start" ? ["a:start", "a:end", "b:start", "b:end"] : ["b:start", "b:end", "a:start", "a:end"]);
  });

  it("lets nested wrappers inherit the verified enclosing lease", async () => {
    const f = await fixture();
    const nested = encode({ lockPath: f.lockPath, cwd: f.directory, args: evalArgs("console.log(process.env.NODE_OPTIONS)") });
    const result = await launch(f, { args: [f.driver, nested] }, {
      NODE_OPTIONS: "--trace-warnings --max-old-space-size=6144",
    }).completed;
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("--trace-warnings --max-old-space-size=2048");
  });

  // Windows nested scripts pay for cold Job helpers and ancestor CIM queries.
  it("preserves pnpm script semantics with real recursive nested scripts and explicit concurrency overrides", async () => {
    const f = await fixture();
    const events = path.join(f.directory, "events");
    const { packageManager } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    await writeFile(path.join(f.directory, "package.json"), JSON.stringify({ name: "fixture-root", private: true, packageManager }));
    await writeFile(path.join(f.directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    for (const id of ["a", "b"]) {
      const pkg = path.join(f.directory, "packages", id);
      await mkdir(pkg, { recursive: true });
      await writeFile(path.join(pkg, "probe.mjs"), `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(events)},'${id}:start\\n');if(!process.env.NODE_OPTIONS.includes('--trace-warnings')||!process.env.NODE_OPTIONS.includes('--max-old-space-size=2048'))process.exitCode=8;setTimeout(()=>fs.appendFileSync(${JSON.stringify(events)},'${id}:end\\n'),200);`);
      const nested = encode({ lockPath: f.lockPath, cwd: pkg, args: ["--max-old-space-size=6144", "probe.mjs"] });
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: `fixture-${id}`, private: true, scripts: { probe: `node "${f.driver}" "${nested}"` } }));
    }
    const result = await launch(f, { command: "pnpm", args: ["--node-options", "--trace-warnings --max-old-space-size-percentage=90", "-r", "--parallel", "--workspace-concurrency", "8", "run", "probe"] }).completed;
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const rows = (await readFile(events, "utf8")).trim().split("\n");
    expect(rows).toEqual(rows[0] === "a:start" ? ["a:start", "a:end", "b:start", "b:end"] : ["b:start", "b:end", "a:start", "a:end"]);
  }, 60_000);

  it("releases ownership after spawn failures", async () => {
    const f = await fixture();
    const failed = await launch(f, { command: path.join(f.directory, "does-not-exist"), args: [] }).completed;
    expect(failed.code).not.toBe(0);
    const next = await launch(f, { args: evalArgs("process.exitCode=0") }).completed;
    expect(next.code).toBe(0);
  });

  it.skipIf(process.platform === "win32")("rejects an unrelated process's copied token and cancels a waiter without releasing the owner", async () => {
    const f = await fixture();
    const ready = path.join(f.directory, "ready");
    const marker = path.join(f.directory, "incorrect-start");
    const a = launch(f, { args: evalArgs(`require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(()=>{},1000)`) });
    await waitFor(ready);
    const owner = await readFile(`${f.lockPath}.owner.json`, "utf8");
    const b = launch(f, { args: evalArgs(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`) }, { [OWNER_ENV]: owner });
    await delay(400);
    b.child.kill("SIGTERM");
    expect((await b.completed).signal).toBe("SIGTERM");
    await expect(stat(marker)).rejects.toThrow();
    expect(await readFile(`${f.lockPath}.owner.json`, "utf8")).toBe(owner);
    a.child.kill("SIGTERM");
    expect((await a.completed).signal).toBe("SIGTERM");
    expect((await launch(f, { args: evalArgs("process.exitCode=0") }).completed).code).toBe(0);
  });

  it.skipIf(process.platform === "win32")("kills running descendants before releasing a cancelled lease", async () => {
    const f = await fixture();
    const ready = path.join(f.directory, "ready");
    const code = `const c=require('child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},String(c.pid));setInterval(()=>{},1000)`;
    const a = launch(f, { args: evalArgs(code) });
    const pid = Number(await waitFor(ready));
    a.child.kill("SIGTERM");
    expect((await a.completed).signal).toBe("SIGTERM");
    if (process.platform === "linux") {
      const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      expect(state === "" || state.slice(state.lastIndexOf(")") + 2).startsWith("Z")).toBe(true);
    }
    expect((await launch(f, { args: evalArgs("process.exitCode=0") }).completed).code).toBe(0);
  });

  it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGKILL"])("drains detached descendants before the next lease after %s", async (signal) => {
    const f = await fixture();
    const ready = path.join(f.directory, "detached-pid");
    const task = `const c=require('child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},String(c.pid));setInterval(()=>{},1000)`;
    const a = launch(f, { args: evalArgs(task) });
    const pid = Number(await waitFor(ready));
    try {
      expect(processRunning(pid)).toBe(true);
      a.child.kill(signal);
      if (signal === "SIGKILL") {
        await new Promise((resolve) => a.child.once("exit", resolve));
        const old = new Date(Date.now() - 60_000);
        await utimes(`${f.lockPath}.lock`, old, old);
      }
      const probe = `const cp=require('child_process');let live=false;try{live=!cp.execFileSync('ps',['-o','stat=','-p',${JSON.stringify(String(pid))}],{encoding:'utf8'}).trim().startsWith('Z')}catch{};console.log(live);process.exitCode=live?9:0`;
      const b = await launch(f, { args: evalArgs(probe) }).completed;
      expect((await a.completed).signal).toBe(signal);
      expect(b.code, b.stderr).toBe(0);
      expect(b.stdout.trim()).toBe("false");
      expect(processRunning(pid)).toBe(false);
    } finally {
      if (processRunning(pid)) process.kill(-pid, "SIGKILL");
    }
  });

  it.skipIf(process.platform === "win32")("drains a detached child when its launcher exits immediately", async () => {
    const f = await fixture();
    const ready = path.join(f.directory, "orphan-pid");
    const task = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},String(c.pid));c.unref()`;
    const a = launch(f, { args: evalArgs(task) });
    const pid = Number(await waitFor(ready));
    try {
      expect((await a.completed).code).toBe(0);
      expect(processRunning(pid)).toBe(false);
      await expect(stat(`${f.lockPath}.owner.json`)).rejects.toThrow();
    } finally { if (processRunning(pid)) process.kill(-pid, "SIGKILL"); }
  });

  it.skipIf(process.platform === "win32").each([true, false])("drains detached groups during stale recovery with journaled=%s even when the bridge is dead", async (journaled) => {
    const f = await fixture();
    const ready = path.join(f.directory, "stale-detached-pid");
    const task = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},String(c.pid));setInterval(()=>{},1000)`;
    const a = launch(f, { args: evalArgs(task) });
    const pid = Number(await waitFor(ready));
    try {
      let owner;
      for (let i = 0; i < 100; i++) {
        owner = JSON.parse(await readFile(`${f.lockPath}.owner.json`, "utf8"));
        if (!journaled || owner.descendantGroups.some((group) => group.pid === pid)) break;
        await delay(20);
      }
      if (journaled) expect(owner.descendantGroups).toContainEqual({ pid, startedAt: processStartedAt(pid) });
      expect(owner.descendantToken).toBeTruthy();
      expect(owner.descendantToken).not.toBe(owner.token);
      expect(owner.ownerStartedAt).toBe(processStartedAt(a.child.pid));
      a.child.kill("SIGSTOP");
      if (!journaled) {
        // Emulate a crash before a polling observation reached the ledger.
        await writeFile(`${f.lockPath}.owner.json`, JSON.stringify({ ...owner, descendantGroups: [] }));
      }
      process.kill(-owner.groupPid, "SIGKILL");
      a.child.kill("SIGKILL");
      await a.completed;
      expect(processRunning(pid)).toBe(true);
      const old = new Date(Date.now() - 60_000);
      await utimes(`${f.lockPath}.lock`, old, old);
      const result = await launch(f, { args: evalArgs("process.exitCode=0") }).completed;
      expect(result.code, result.stderr).toBe(0);
      expect(processRunning(pid)).toBe(false);
    } finally { if (processRunning(pid)) process.kill(-pid, "SIGKILL"); }
  });

  it.skipIf(process.platform === "win32")("leaves an unrelated detached group with copied public owner JSON alive", async () => {
    const f = await fixture();
    const ready = path.join(f.directory, "owned-ready");
    const a = launch(f, { args: evalArgs(`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`) });
    await waitFor(ready);
    const recorded = JSON.parse(await readFile(`${f.lockPath}.owner.json`, "utf8"));
    const unrelatedReady = path.join(f.directory, "unrelated-pid");
    const unrelated = spawn(process.execPath, evalArgs(`require('fs').writeFileSync(${JSON.stringify(unrelatedReady)},String(process.pid));setInterval(()=>{},1000)`), {
      detached: true, stdio: "ignore", env: { ...process.env,
        [OWNER_ENV]: JSON.stringify({ pid: recorded.pid, path: recorded.path, token: recorded.token }),
        [DESCENDANT_ENV]: randomUUID(),
      },
    });
    const finished = new Promise((resolve) => unrelated.once("close", resolve));
    try {
      await waitFor(unrelatedReady);
      a.child.kill("SIGTERM");
      expect((await a.completed).signal).toBe("SIGTERM");
      expect(processRunning(unrelated.pid)).toBe(true);
      expect((await launch(f, { args: evalArgs("process.exitCode=0") }).completed).code).toBe(0);
      expect(processRunning(unrelated.pid)).toBe(true);
    } finally { unrelated.kill("SIGKILL"); await finished; }
  });

  it("distinguishes live owners with reused PIDs while keeping legacy owners fail closed", () => {
    const current = processStartedAt(process.pid);
    expect(ownerRunning({ pid: process.pid, ownerStartedAt: current })).toBe(true);
    expect(ownerRunning({ pid: process.pid, ownerStartedAt: "different-start" })).toBe(false);
    expect(ownerRunning({ pid: process.pid })).toBe(true);
    expect(ownerRunning({ pid: 2147483647, ownerStartedAt: "old" })).toBe(false);
  }, 30_000);

  it("publishes process identity only in the sidecar, keeping inherited environment at three fields", async () => {
    const f = await fixture();
    const result = await launch(f, { args: evalArgs(`console.log(Object.keys(JSON.parse(process.env.${OWNER_ENV})).sort().join(','))`) }).completed;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("path,pid,token");
  }, 30_000);

  it("recovers a stale owner whose live PID has a different start identity", async () => {
    const f = await fixture();
    await mkdir(`${f.lockPath}.lock`);
    await writeFile(`${f.lockPath}.owner.json`, JSON.stringify({ pid: process.pid, ownerStartedAt: "different-start", path: f.lockPath, token: "old" }));
    const old = new Date(Date.now() - 60_000);
    await utimes(`${f.lockPath}.lock`, old, old);
    const result = await launch(f, { args: evalArgs("process.exitCode=0") }).completed;
    expect(result.code, result.stderr).toBe(0);
    expect(processStartedAt(process.pid)).toBeTruthy();
  }, 30_000);

  it("refuses stale recovery when a live legacy owner has no start identity", async () => {
    const f = await fixture();
    await mkdir(`${f.lockPath}.lock`);
    const owner = { pid: process.pid, path: f.lockPath, token: "old" };
    await writeFile(`${f.lockPath}.owner.json`, JSON.stringify(owner));
    const old = new Date(Date.now() - 60_000);
    await utimes(`${f.lockPath}.lock`, old, old);
    const result = await launch(f, { args: evalArgs("process.exitCode=0") }).completed;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("live owner");
    expect(JSON.parse(await readFile(`${f.lockPath}.owner.json`, "utf8"))).toEqual(owner);
  }, 30_000);

  it.skipIf(process.platform === "win32")("recovers a SIGKILL lease and terminates the old group before starting the next command", async () => {
    const f = await fixture();
    const ready = path.join(f.directory, "ready");
    const a = launch(f, { args: evalArgs(`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`) });
    await waitFor(ready);
    const owner = JSON.parse(await readFile(`${f.lockPath}.owner.json`, "utf8"));
    a.child.kill("SIGKILL");
    // Its descendants deliberately survive SIGKILL of the wrapper. Do not
    // await pipe closure until the stale successor has killed that group.
    await new Promise((resolve) => a.child.once("exit", resolve));
    const old = new Date(Date.now() - 60_000);
    await utimes(`${f.lockPath}.lock`, old, old);
    const result = await launch(f, { args: evalArgs("process.exitCode=0") }).completed;
    expect(result.code).toBe(0);
    expect((await a.completed).signal).toBe("SIGKILL");
    expect(owner.groupPid).toBeGreaterThan(0);
    await expect(stat(`${f.lockPath}.owner.json`)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32").each(["primary", "descendant"])("leaves a reused live %s process group alone during stale recovery", async (kind) => {
    const f = await fixture();
    const ready = path.join(f.directory, "unrelated-ready");
    const unrelated = spawn(process.execPath, evalArgs(`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`), { detached: true, stdio: "ignore" });
    const finished = new Promise((resolve) => unrelated.once("close", resolve));
    try {
      await waitFor(ready);
      await mkdir(`${f.lockPath}.lock`);
      await writeFile(`${f.lockPath}.owner.json`, JSON.stringify({ pid: 2147483647, path: f.lockPath, token: "old-lease",
        groupPid: kind === "primary" ? unrelated.pid : 2147483646,
        groupStartedAt: "different-start",
        descendantGroups: kind === "descendant" ? [{ pid: unrelated.pid, startedAt: "different-start" }] : [],
      }));
      const old = new Date(Date.now() - 60_000);
      await utimes(`${f.lockPath}.lock`, old, old);
      expect((await launch(f, { args: evalArgs("process.exitCode=0") }).completed).code).toBe(0);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGTERM");
      await finished;
    }
  });
});
