import fc from "fast-check";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execGit, type GitProcessEvent } from "./dugite";
import { createSystemGit } from "./test-support/system-git";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

async function assertTreeStops(parentExits: boolean, helperDetached = false): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-abort-tree-"));
  const fixture = join(root, "helper.cjs");
  const pidFile = join(root, "helper.pid");
  writeFileSync(fixture, `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2], detached: process.argv[4] === 'detached' });
    child.once('spawn', () => {
      writeFileSync(process.argv[2], String(child.pid));
      child.unref();
      process.stderr.write('helper ready\\n');
      if (process.argv[3] === 'exit') process.exit(0);
      else setInterval(() => {}, 1000);
    });
  `);
  const controller = new AbortController();
  const reason = { kind: "remote" as const, code: "pull_stalled", message: "deadline" };
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => { ready = resolve; });
  const operation = execGit([
    "-c", `alias.stall=!${quote(process.execPath)} ${quote(fixture)} ${quote(pidFile)} ${parentExits ? "exit" : "wait"} ${helperDetached ? "detached" : "attached"}`,
    "stall"
  ], root, {
    signal: controller.signal, killSignal: "SIGKILL",
    onStderr: (chunk) => { if (!parentExits && chunk.includes("helper ready")) ready(); },
    onProcess: (event) => { if (parentExits && event.event === "exit") ready(); }
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await readiness;
    controller.abort(reason);
    const settled = await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 500); })
    ]);
    expect(settled, "abort must settle even after Git exited with inherited pipes open").toBe(true);
    expect(await operation).toEqual({ ok: false, error: reason });
    const pid = readFileSync(pidFile, "utf8").trim();
    await vi.waitFor(() => {
      let alive = true;
      try {
        process.kill(Number(pid), 0);
        // Minimal Linux containers may leave killed orphans as zombies until
        // PID 1 reaps them; they no longer execute or hold the inherited pipes.
        if (process.platform === "linux") alive = !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH" || (cause as NodeJS.ErrnoException).code === "ENOENT") alive = false;
        else throw cause;
      }
      expect(alive, "abort must kill its own group, preserve an external owner, and close inherited pipes in either case").toBe(helperDetached);
    });
  } finally {
    clearTimeout(deadline);
    controller.abort(reason);
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already stopped. */ }
    }
    await operation;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Git process lifecycle oracle", () => {
  // POSIX process groups: a helper can outlive Git and retain its pipes.
  // The real processes are the oracle, including the already-exited-parent case.
  it.skipIf(process.platform === "win32")("abort bounds any live or exited Git process and its inherited-pipe helper", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), assertTreeStops), { numRuns: 10 });
  });

  it.skipIf(process.platform === "win32")("settles cancellation after Git exits while its helper keeps the pipes open", async () => {
    await assertTreeStops(true);
  });

  it.skipIf(process.platform === "win32")("closes retained pipes without killing an external shared connection owner", async () => {
    await assertTreeStops(true, true);
  });
  it("production and fixture executors report spawn, exit, and pipe closure in order", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("--version", "not-a-git-command"), async (command) => {
      for (const git of [execGit, createSystemGit()]) {
        const events: GitProcessEvent[] = [];
        let closed!: () => void;
        const closure = new Promise<void>((resolve) => { closed = resolve; });
        const result = await git([command], tmpdir(), { onProcess: (event) => {
          events.push(event);
          if (event.event === "close") closed();
        } });
        // The fixture can settle once streams end and Git exits, before Node's
        // later close event. Compare the complete observed lifecycle.
        await closure;
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(events.map((event) => event.event)).toEqual(["spawn", "exit", "close"]);
        expect(events[0]?.pid).toBeGreaterThan(0);
        expect(events.every((event) => event.pid === events[0]?.pid)).toBe(true);
        expect(events[1]?.exitCode).toBe(result.value.exitCode);
        expect(events[2]?.exitCode).toBe(result.value.exitCode);
      }
    }), { numRuns: 10 });
  });
});
