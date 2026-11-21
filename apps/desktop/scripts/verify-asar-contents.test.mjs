import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";

const verifier = fileURLToPath(new URL("./verify-asar-contents.mjs", import.meta.url));

const unpackedEntries = [undefined, "prune-size-worker.mjs", "chromium-trace-worker.mjs"];

it.each(unpackedEntries)("verifies ASAR worker placement (unpacked: %s)", async (unpacked) => {
  const root = await mkdtemp(join(tmpdir(), "pwrgit-asar-test-"));
  try {
    const input = join(root, "input");
    const main = join(input, "out", "main");
    const renderer = join(input, "out", "renderer");
    await Promise.all([mkdir(main, { recursive: true }), mkdir(renderer, { recursive: true })]);
    await Promise.all([
      writeFile(join(main, "index.js"), "export {};"),
      writeFile(join(main, "prune-size-worker.mjs"), "export {};"),
      writeFile(join(main, "chromium-trace-worker.mjs"), "export {};"),
      writeFile(join(renderer, "index.html"), "<!doctype html><title>PwrGit</title>")
    ]);
    const archive = join(root, "app.asar");
    await createPackageWithOptions(input, archive, unpacked ? { unpack: unpacked } : {});
    const result = spawnSync(process.execPath, [verifier, archive], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(unpacked ? 1 : 0);
    if (unpacked) expect(result.stderr).toContain(`worker must be packed: /out/main/${unpacked}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
