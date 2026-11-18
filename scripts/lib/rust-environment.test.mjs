import path from "node:path";
import { expect, it, vi } from "vitest";
import { rustEnvironment } from "./rust-environment.mjs";

const missing = Object.assign(new Error("missing"), { code: "ENOENT" });

it("keeps PATH Cargo authoritative, including its own toolchain errors", () => {
  const env = { PATH: "operator cargo", RUSTUP_TOOLCHAIN: "override" };
  const spawn = vi.fn(() => ({ status: 1 }));
  expect(rustEnvironment({ env, spawn })).toBe(env);
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("resolves in the checkout and carries compiler siblings without mutating env", () => {
  const executable = path.resolve("custom toolchain/bin/cargo");
  const env = { Path: "original", RUSTUP_TOOLCHAIN: "override", CARGO_HOME: "custom cargo" };
  const spawn = vi.fn().mockReturnValueOnce({ error: missing })
    .mockReturnValueOnce({ status: 0, stdout: executable + "\n" });
  expect(rustEnvironment({ cwd: "checkout", env, spawn })).toEqual({
    ...env, Path: path.dirname(executable) + path.delimiter + env.Path
  });
  expect(env.Path).toBe("original");
  expect(spawn).toHaveBeenLastCalledWith("rustup", ["which", "cargo"], { cwd: "checkout", env, encoding: "utf8" });
});

it("does not mask permission errors with a toolchain fallback", () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const spawn = vi.fn(() => ({ error: denied }));
  expect(() => rustEnvironment({ spawn })).toThrow(denied);
  expect(spawn).toHaveBeenCalledTimes(1);
});

it.each([
  { error: missing }, { status: 1, stderr: "no active toolchain" },
  { status: 0, stdout: "" }, { status: 0, stdout: "relative/cargo" }
])("explains unavailable Cargo without guessing an installation path: %j", (lookup) => {
  const spawn = vi.fn().mockReturnValueOnce({ error: missing }).mockReturnValueOnce(lookup);
  expect(() => rustEnvironment({ spawn })).toThrow("Cargo is not on PATH and Rustup could not locate");
});
