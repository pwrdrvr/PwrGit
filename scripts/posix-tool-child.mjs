import { spawn } from "node:child_process";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

// The lease owner records this process group before sending "start". Until
// then no heavy tool exists. Every descendant stays in this owned group.
export function runPosixToolChild() {
  if (!process.connected) throw new Error("The POSIX tool gate requires its lease owner's IPC channel");
  const ownerPid = process.ppid;
  const ownerWatch = setInterval(() => {
    try { process.kill(ownerPid, 0); }
    catch { process.kill(-process.pid, "SIGKILL"); }
  }, 100);
  process.once("disconnect", () => process.kill(-process.pid, "SIGKILL"));
  process.once("message", ({ command, args }) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", (error) => {
      console.error(error.message);
      process.exitCode = 127;
      finish();
    });
    child.once("close", (code, signal) => {
      process.exitCode = code ?? 1;
      if (signal) console.error(`[resources] Tool exited with ${signal}.`);
      finish();
    });
  });

  function finish() {
    clearInterval(ownerWatch);
    process.removeAllListeners("disconnect");
    if (process.connected) process.disconnect();
  }
}

if (isCliEntrypoint(import.meta.url)) {
  try { runPosixToolChild(); }
  catch (error) { console.error(error.message); process.exitCode = 127; }
}
