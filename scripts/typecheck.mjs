import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

// Keep the JS compiler available for dependency-cruiser and MCP emit. Resolve
// the native CLI explicitly: both packages publish a binary named `tsc`.
export function compilerPath(compiler = "native") {
  if (compiler !== "native" && compiler !== "typescript") {
    throw new Error("PWRGIT_TYPECHECK_COMPILER must be native or typescript");
  }
  return fileURLToPath(new URL(compiler === "native"
    ? "../node_modules/typescript-native/bin/tsc"
    : "../node_modules/typescript/lib/tsc.js", import.meta.url));
}

export function runCli() {
  const result = spawnSync(process.execPath, [
    compilerPath(process.env.PWRGIT_TYPECHECK_COMPILER), ...process.argv.slice(2),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
}

if (isCliEntrypoint(import.meta.url)) runCli();
