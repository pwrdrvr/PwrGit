import { spawnSync } from "node:child_process";
import path from "node:path";

// Homebrew can expose rustup without its separate Cargo proxy directory.
// Ask Rustup for the active toolchain in this checkout, rather than guessing
// ~/.cargo/bin, a package-manager prefix, or a particular toolchain version.
export function rustEnvironment({ cwd, env = process.env, spawn = spawnSync } = {}) {
  const options = { cwd, env, encoding: "utf8" };
  const cargo = spawn("cargo", ["--version"], options);
  if (!cargo.error) return env;
  if (cargo.error.code !== "ENOENT") throw cargo.error;
  const lookup = spawn("rustup", ["which", "cargo"], options);
  const executable = lookup.stdout?.trim();
  if (lookup.error || lookup.status !== 0 || !executable || !path.isAbsolute(executable)) {
    throw new Error(
      "Cargo is not on PATH and Rustup could not locate an active Cargo toolchain. " +
      "Install Rust or add its Cargo bin directory to the Dev action's PATH." +
      (lookup.stderr?.trim() ? `\n${lookup.stderr.trim()}` : ""),
      { cause: lookup.error ?? cargo.error }
    );
  }
  // Cargo also needs its sibling rustc. Child build/license checks inherit
  // this environment; the caller's environment and resource policy stay intact.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [pathKey]: [path.dirname(executable), env[pathKey]].filter(Boolean).join(path.delimiter) };
}
