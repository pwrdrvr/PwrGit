// Contrived fixture: only the detached holder inherits stdout/stderr after
// the launcher exits. A readiness/release handshake avoids timing races.
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const [mode, ready, release] = process.argv.slice(2);
if (mode === "holder") {
  process.stdout.on("error", () => process.exit(0));
  writeFileSync(ready, String(process.pid));
  const poll = setInterval(() => {
    if (existsSync(release)) {
      clearInterval(poll);
      writeFileSync(`${release}.done`, "done");
      process.stdout.write("holder-released\n", () => process.exit(0));
    }
  }, 20);
  setTimeout(() => process.exit(2), 12_000).unref();
} else {
  const holder = spawn(process.execPath, [__filename, "holder", ready, release], {
    detached: true, windowsHide: true, cwd: tmpdir(), stdio: ["ignore", 1, 2]
  });
  holder.unref();
  const poll = setInterval(() => {
    if (existsSync(ready)) {
      clearInterval(poll);
      process.stdout.write("launcher-exited\n", () => process.exit(0));
    }
  }, 20);
  setTimeout(() => process.exit(3), 10_000).unref();
}
