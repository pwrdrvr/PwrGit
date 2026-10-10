import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";
import { createPosixProcessTracker, DESCENDANT_ENV, processStartedAt } from "./lib/tool-processes.mjs";

// A live IPC gate lets us publish its start identity before a fast-exiting
// command starts. The private marker also finds detached, reparented children.
export async function runBenchmarkCommand(command, args, {
  cwd = process.cwd(), env = process.env, timeoutMs = 600_000,
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  if (process.platform === "win32") throw new Error("Benchmark commands require POSIX process groups");
  const token = randomUUID();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd, env: { ...env, [DESCENDANT_ENV]: token }, detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let tracker;
  let timer;
  let failure;
  let outcome;
  let stopping;
  let rejectCleanup;
  const cleanupFailure = new Promise((_, reject) => { rejectCleanup = reject; });
  cleanupFailure.catch(() => {});
  const stdout = [];
  const stderr = [];
  const stop = (error) => {
    failure ??= error;
    // Drain freezes parents before taking the final descendant snapshot and
    // awaits termination, including groups which escaped the original PGID.
    stopping ??= tracker ? tracker.drain() : Promise.resolve();
    stopping.catch(rejectCleanup);
  };
  const onInt = () => stop(Object.assign(new Error("Benchmark interrupted by SIGINT"), { code: "ABORT_ERR" }));
  const onTerm = () => stop(Object.assign(new Error("Benchmark interrupted by SIGTERM"), { code: "ABORT_ERR" }));
  const capture = (stream, chunks) => {
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBuffer) chunks.push(chunk);
      else stop(Object.assign(new Error("Benchmark command exceeded output limit"), { code: "ENOBUFS" }));
    });
  };
  capture(child.stdout, stdout);
  capture(child.stderr, stderr);
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
    child.on("message", (message) => {
      if (message.type === "result") outcome = message;
    });
  });
  completion.catch(() => {});
  try {
    if (!child.pid) return { ...(await completion), stdout: "", stderr: "" };
    const startedAt = processStartedAt(child.pid);
    if (!startedAt) throw new Error("Cannot identify the benchmark command gate");
    tracker = createPosixProcessTracker({ pid: child.pid, startedAt }, [], { descendantToken: token });
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    timer = setTimeout(() => stop(Object.assign(new Error(`Benchmark command timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })), timeoutMs);
    child.send({ command, args });
    // A failed drain must abort the benchmark rather than wait indefinitely
    // for pipes held by descendants or allow another sample to start.
    const result = await Promise.race([
      completion,
      new Promise((_, reject) => {
        child.on("message", (message) => {
          if (message.type === "cleanup-error") reject(new Error(message.message));
        });
      }),
      cleanupFailure,
    ]);
    if (stopping) await stopping;
    return {
      ...result, ...(outcome && { status: outcome.status, signal: outcome.signal }),
      stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
      error: failure ?? (outcome?.error && Object.assign(new Error(outcome.error.message), { code: outcome.error.code })),
    };
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (tracker) await tracker.drain();
    else if (child.pid) { child.kill("SIGKILL"); await completion; }
  }
}

export function runCommandGate() {
  if (!process.connected) throw new Error("Benchmark command gate requires IPC");
  const tracker = createPosixProcessTracker(
    { pid: process.pid, startedAt: processStartedAt(process.pid) }, [],
    { descendantToken: process.env[DESCENDANT_ENV] },
  );
  let finishing = false;
  const observer = setInterval(() => {
    try { tracker.observe(); }
    catch (error) { void finish(1, null, error); }
  }, 100);
  process.once("disconnect", () => { void finish(1); });
  process.once("message", ({ command, args }) => {
    if (finishing) return;
    const tool = spawn(command, args, { stdio: "inherit" });
    tool.once("error", (error) => { void finish(127, null, error); });
    tool.once("close", (status, signal) => { void finish(status, signal); });
  });
  async function finish(status, signal, error) {
    if (finishing) return;
    finishing = true;
    clearInterval(observer);
    try {
      await tracker.drain();
      if (process.connected) {
        process.send({ type: "result", status, signal, error: error && { message: error.message, code: error.code } });
        process.disconnect();
      }
      process.exitCode = status ?? 1;
    } catch (cleanupError) {
      if (process.connected) process.send({ type: "cleanup-error", message: cleanupError.message });
      // Stay alive with our ownership identity so the parent can retry cleanup.
      setTimeout(() => { finishing = false; void finish(status, signal, error); }, 100);
    }
  }
}

if (isCliEntrypoint(import.meta.url)) runCommandGate();
