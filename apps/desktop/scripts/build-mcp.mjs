#!/usr/bin/env node
// Native stdio transport. Packaged macOS helpers are universal; developer/test
// builds may request --host. Fail rather than ship a missing/stale executable.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = join(root, "crates/pwrgit-mcp/Cargo.toml");
const output = join(root, "apps/desktop/build/mcp");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
mkdirSync(output, { recursive: true });
const targets =
  process.platform === "darwin" && !process.argv.includes("--host")
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    : [];
if (targets.length) {
  run("rustup", ["target", "add", ...targets]);
  for (const target of targets)
    run("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      manifest,
      "--target",
      target
    ]);
  run("lipo", [
    "-create",
    ...targets.map((target) =>
      join(root, "crates/pwrgit-mcp/target", target, "release/pwrgit-mcp")
    ),
    "-output",
    join(output, "pwrgit-mcp")
  ]);
} else {
  run("cargo", ["build", "--locked", "--release", "--manifest-path", manifest]);
  const name = process.platform === "win32" ? "pwrgit-mcp.exe" : "pwrgit-mcp";
  copyFileSync(resolve(root, "crates/pwrgit-mcp/target/release", name), join(output, name));
}

run(process.execPath, [join(root, "scripts/check-mcp-rust-licenses.mjs"), "--verify-cargo"]);
