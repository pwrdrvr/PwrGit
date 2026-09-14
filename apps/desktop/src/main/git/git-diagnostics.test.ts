import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { beginGitDiagnostic, configureGitDiagnostics, gitDiagnosticContext, safeGitIdentity, type GitDiagnosticReport } from "./git-diagnostics";
import { execGit, execGitBinary, execGitRecords } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import { diagnoseSyncGit } from "./test-support/diagnostic-sync";

let reports: GitDiagnosticReport[] = [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function enable(thresholdMs = 150, processSample = false): void {
  reports = [];
  configureGitDiagnostics({ thresholdMs, processSample, emit: (report) => {
    reports.push(report);
    const directory = process.env.PWRGIT_GIT_DIAGNOSTICS_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, `controlled-${process.pid}.jsonl`), `${JSON.stringify(report)}\n`);
    }
  } });
}
afterEach(() => configureGitDiagnostics(undefined));

function observe(child: ChildProcess) {
  const diagnostic = beginGitDiagnostic("controlled-git", ["hash-object", "--stdin"], tmpdir())!;
  const counts = [child.listenerCount("exit"), child.stdout?.listenerCount("end")];
  diagnostic.attach(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { diagnostic.output("stdout", chunk); output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => diagnostic.output("stderr", chunk));
  let settled = false;
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => { diagnostic.settle("rejected"); reject(error); });
    child.once("close", () => { settled = true; diagnostic.settle("resolved"); resolve(); });
  });
  return { diagnostic, done, counts, output: () => output, settled: () => settled };
}

function pipeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-pipes-"));
  const ready = join(directory, "ready");
  const release = join(directory, "release");
  const quote = (path: string): string => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  const fixture = fileURLToPath(new URL("./test-support/pipe-holder.cjs", import.meta.url));
  const alias = `!${[process.execPath, fixture, "launcher", ready, release].map(quote).join(" ")}`;
  return { directory, ready, release, args: ["-c", `alias.diagnostic=${alias}`, "diagnostic"] };
}

describe("Git lifecycle diagnostics", () => {
  it("distinguishes a live Git waiting on stdin and captures bounded OS evidence", async () => {
    enable(100, true);
    const child = spawn("git", ["hash-object", "--stdin"], { cwd: tmpdir() });
    const run = observe(child);
    try {
      await expect.poll(() => reports.some((r) => r.event === "os-process-sample"), { timeout: 4000 }).toBe(true);
      expect(reports.find((r) => r.event === "slow-trigger")).toMatchObject({
        pid: child.pid, terminationObserved: false, exitCode: null, settled: false,
        streams: { stdout: { readableEnded: false }, stdin: { writableEnded: false } }
      });
      expect(run.settled()).toBe(false);
    } finally { child.stdin.end("fixture"); await run.done; }
    expect(run.output()).toMatch(/^[a-f0-9]{40,64}\s*$/);
    expect(reports.some((r) => r.event === "promise-resolved")).toBe(true);
    expect(gitDiagnosticContext().active).toEqual([]);
    expect(child.listenerCount("exit")).toBe(run.counts[0]);
    expect(child.stdout.listenerCount("end")).toBe(run.counts[1]);
  });

  it("observes Git exit with a detached descendant holding both pipes, without completing or truncating", async () => {
    enable();
    const { directory, ready, release, args } = pipeFixture();
    const child = spawn("git", args, { cwd: tmpdir() });
    const run = observe(child);
    const exit = once(child, "exit");
    try {
      await exit;
      await expect.poll(() => reports.some((r) => r.terminationObserved === true)).toBe(true);
      expect(Number(readFileSync(ready, "utf8"))).toBeGreaterThan(0);
      expect(run.diagnostic.snapshot()).toMatchObject({
        terminationObserved: true, exitCode: 0, childCloseObserved: false, settled: false,
        streams: { stdout: { readableEnded: false }, stderr: { readableEnded: false } }
      });
      expect(run.settled()).toBe(false);
    } finally {
      writeFileSync(release, "release");
      await run.done;
      rmSync(directory, { recursive: true, force: true });
    }
    expect(run.output()).toBe("launcher-exited\nholder-released\n");
    const timeline = run.diagnostic.snapshot().timeline as { event: string; atMs: number }[];
    expect(timeline.map((e) => e.event)).toEqual(expect.arrayContaining(["spawn", "exit", "stdout-end", "stderr-end", "child-close", "promise-resolved"]));
    expect(timeline.findIndex((e) => e.event === "exit")).toBeLessThan(timeline.findIndex((e) => e.event === "stdout-end"));
    expect(timeline.every((e, i) => i === 0 || e.atMs >= timeline[i - 1]!.atMs)).toBe(true);
  });

  it.each(["text", "binary"] as const)("keeps Dugite %s pending after Git exits until inherited pipes drain", async (mode) => {
    enable(100);
    const { directory, release, args } = pipeFixture();
    let settled = false;
    const done = (mode === "text" ? execGit(args, tmpdir()) : execGitBinary(args, tmpdir())).then((result) => {
      settled = true;
      return result;
    });
    try {
      await expect.poll(() => reports.some((r) => r.terminationObserved === true), { timeout: 5000 }).toBe(true);
      expect(settled).toBe(false);
      expect(reports.find((r) => r.terminationObserved === true)).toMatchObject({
        exitCode: 0, settled: false, streams: { stdout: { readableEnded: false }, stderr: { readableEnded: false } }
      });
    } finally {
      writeFileSync(release, "release");
      await done;
      rmSync(directory, { recursive: true, force: true });
    }
    const result = await done;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stdout.toString()).toBe("launcher-exited\nholder-released\n");
    expect(reports.some((r) => r.event === "promise-resolved")).toBe(true);
  });

  it("reports the existing system-helper grace expiry even below five seconds", async () => {
    enable(5000);
    const { directory, release, args } = pipeFixture();
    try {
      const result = await createSystemGit()(args, tmpdir());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.stdout).toBe("launcher-exited\n");
      expect(reports.find((r) => r.event === "helper-flush-grace-expired")).toMatchObject({
        exitCode: 0, terminationObserved: true, settled: false,
        streams: { stdout: { readableEnded: false, destroyed: false } }
      });
    } finally {
      writeFileSync(release, "release");
      await expect.poll(() => { try { return readFileSync(`${release}.done`, "utf8"); } catch { return ""; } }).toBe("done");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps fast output intact and leaves no diagnostic listeners or timers", async () => {
    enable(5000);
    const child = spawn("git", ["--version"], { cwd: tmpdir() });
    const run = observe(child);
    await run.done;
    expect(run.output()).toMatch(/^git version /);
    expect(reports).toEqual([]);
    expect(gitDiagnosticContext().active).toEqual([]);
    expect(child.listenerCount("exit")).toBe(run.counts[0]);
    expect(child.stdout.listenerCount("end")).toBe(run.counts[1]);
  });

  it("measures a late timer and does not equate a signal request with termination", async () => {
    enable(30);
    const diagnostic = beginGitDiagnostic("controlled-loop", [], tmpdir())!;
    const started = performance.now();
    while (performance.now() - started < 100) { /* Deliberate controlled starvation. */ }
    await sleep(5);
    expect(reports[0]).toMatchObject({ event: "slow-trigger", terminationObserved: false });
    expect(Number(reports[0]!.timerLatenessMs)).toBeGreaterThan(50);
    diagnostic.dispose();
    const child = spawn("git", ["hash-object", "--stdin"], { cwd: tmpdir() });
    const run = observe(child);
    await once(child, "spawn");
    child.kill();
    expect(run.diagnostic.snapshot()).toMatchObject({ killed: true, terminationObserved: false });
    await run.done;
    expect(run.diagnostic.snapshot()).toMatchObject({ terminationObserved: true });
  });

  it("disposes a pending observation without touching the child or its flow", async () => {
    enable(50);
    const child = spawn("git", ["hash-object", "--stdin"], { cwd: tmpdir() });
    const run = observe(child);
    try {
      const flowing = child.stdout.readableFlowing;
      configureGitDiagnostics(undefined);
      expect(child.killed).toBe(false);
      expect(child.stdout.destroyed).toBe(false);
      expect(child.stdout.readableFlowing).toBe(flowing);
      const count = reports.length;
      await sleep(100);
      expect(reports).toHaveLength(count);
    } finally { child.stdin.end(); await run.done; }
  });

  it("reports blocked synchronous completion even when the diagnostic timer cannot fire", () => {
    enable(20);
    const result = diagnoseSyncGit(["status"], tmpdir(), () => {
      const started = performance.now();
      while (performance.now() - started < 50) { /* Controlled synchronous call. */ }
      return "unchanged-result";
    });
    expect(result).toBe("unchanged-result");
    expect(reports[0]).toMatchObject({ event: "slow-settlement-before-timer", timerLatenessMs: null });
    expect(gitDiagnosticContext().active).toEqual([]);
  });

  it("does not start paused pipes flowing or handle otherwise unhandled stream errors", async () => {
    enable(5000);
    const child = spawn("git", ["hash-object", "--stdin"], { cwd: tmpdir() });
    const diagnostic = beginGitDiagnostic("passive-observation", [], tmpdir())!;
    const flowing = child.stdout.readableFlowing;
    diagnostic.attach(child);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      expect(child.stdout.readableFlowing).toBe(flowing);
      expect(child.stdout.listenerCount("data")).toBe(0);
      const error = new Error("contrived-stream-error");
      expect(() => child.stdout.emit("error", error)).toThrow(error);
      expect((diagnostic.snapshot().timeline as { event: string }[]).map((event) => event.event)).toContain("stdout-error");
    } finally {
      // The test becomes the pipe consumer only after checking observation.
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end();
      await closed;
      diagnostic.settle("resolved");
    }
  });

  it("records spawn errors and cleans up without changing rejection handling", async () => {
    enable(5000);
    const child = spawn(join(tmpdir(), "pwrgit-nonexistent-diagnostic-command"), []);
    const run = observe(child);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await expect(run.done).rejects.toHaveProperty("code", "ENOENT");
    await closed;
    expect((run.diagnostic.snapshot().timeline as { event: string }[]).map((event) => event.event))
      .toEqual(expect.arrayContaining(["child-error", "promise-rejected", "child-close"]));
    expect(gitDiagnosticContext().active).toEqual([]);
  });

  it("redacts command values, cwd, output and environment by construction", async () => {
    enable(1);
    const secret = "private-token-credential";
    expect(JSON.stringify(safeGitIdentity(["-c", `x=${secret}`, "fetch", `https://${secret}@example.com`], `/home/${secret}`))).not.toContain(secret);
    const diagnostic = beginGitDiagnostic("redaction-fixture", ["show", secret], secret)!;
    diagnostic.output("stdout", Buffer.from(secret));
    await sleep(10);
    diagnostic.settle("resolved");
    expect(JSON.stringify(reports)).not.toContain(secret);
    expect(reports.at(-1)).toMatchObject({ bytes: { stdout: Buffer.byteLength(secret) } });
  });

  it("instruments real system and all Dugite invocation paths", async () => {
    enable(5000);
    const system = await createSystemGit()(["--version"], tmpdir());
    const text = await execGit(["--version"], tmpdir());
    const binary = await execGitBinary(["--version"], tmpdir());
    const records = await execGitRecords(["--version"], tmpdir(), { maxRecords: 10, maxChars: 1000, matches: () => true });
    expect([system.ok, text.ok, binary.ok, records.ok]).toEqual([true, true, true, true]);
    const recent = gitDiagnosticContext().recent as GitDiagnosticReport[];
    expect(recent.map((r) => r.source)).toEqual(["system-git", "dugite-exec", "dugite-binary", "dugite-records"]);
    for (const report of recent) {
      expect(report).toMatchObject({ terminationObserved: true, settled: true, exitCode: 0 });
      expect((report.bytes as { stdout: number }).stdout).toBeGreaterThan(0);
    }
  });
});
