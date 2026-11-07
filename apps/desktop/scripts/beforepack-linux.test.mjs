import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import beforePack from "./beforepack-dugite-arch.mjs";
import { stageRuntime } from "./stage-runtime.mjs";

vi.mock("./stage-runtime.mjs", () => ({ stageRuntime: vi.fn() }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const roots = [];

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  vi.stubEnv("PWRGIT_RUNTIME_CACHE", join(tmpdir(), "pwrgit-test-runtime-cache"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createApp(platform, arch) {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-linux-hook-"));
  roots.push(root);
  const sqlite = join(root, "node_modules", "better-sqlite3");
  mkdirSync(join(sqlite, "prebuilds"), { recursive: true });
  writeFileSync(join(sqlite, "package.json"), JSON.stringify({ version: "13.0.3", gypfile: false }));
  writeFileSync(join(sqlite, "prebuilds", `${platform}-${arch}.node`), arch);
  return root;
}

test.each([[1, "x64"], [3, "arm64"]])("Linux %s packaging stages SQLite and the pinned custom runtime", async (archEnum, arch) => {
  const root = createApp("linux", arch);
  await beforePack({ arch: archEnum, electronPlatformName: "linux", packager: { info: { appDir: root } } });
  expect(readFileSync(join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "utf8")).toBe(arch);
  expect(stageRuntime).toHaveBeenCalledExactlyOnceWith({
    manifestPath: join(root, "custom-git-runtime.json"),
    platform: "linux", arch,
    output: join(root, "node_modules", "dugite", "git"),
    cache: process.env.PWRGIT_RUNTIME_CACHE,
  });
});

test("a failed custom runtime verification stops packaging", async () => {
  const root = createApp("linux", "x64");
  vi.mocked(stageRuntime).mockRejectedValueOnce(new Error("Custom Git archive checksum mismatch"));
  await expect(beforePack({ arch: 1, electronPlatformName: "linux", packager: { info: { appDir: root } } }))
    .rejects.toThrow("Custom Git archive checksum mismatch");
});

test("a cross-platform build is rejected before custom runtime staging", async () => {
  const root = createApp("linux", "x64");
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  await expect(beforePack({ arch: 1, electronPlatformName: "linux", packager: { info: { appDir: root } } }))
    .rejects.toThrow("host matching the target platform");
  expect(stageRuntime).not.toHaveBeenCalled();
});

test.each([[1, "x64"], [3, "arm64"]])("Windows %s packaging retains its existing Git distribution", async (archEnum, arch) => {
  const root = createApp("win32", arch);
  await beforePack({ arch: archEnum, electronPlatformName: "win32", packager: { info: { appDir: root } } });
  expect(readFileSync(join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "utf8")).toBe(arch);
  expect(stageRuntime).not.toHaveBeenCalled();
});
