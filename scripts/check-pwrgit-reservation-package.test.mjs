import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkPackedFiles,
  checkReservationManifest,
  checkReservationPackage,
} from "./check-pwrgit-reservation-package.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = resolve(repoRoot, "packages", "pwrgit");
const manifest = JSON.parse(
  readFileSync(resolve(packageDir, "package.json"), "utf8"),
);
const readme = readFileSync(resolve(packageDir, "README.md"), "utf8");

describe("pwrgit npm reservation package", () => {
  it("has honest public metadata and packs only documentation", () => {
    expect(checkReservationPackage(packageDir)).toEqual([]);
  });

  it("rejects product entry points, runtime dependencies, and placeholder copy", () => {
    const misleading = {
      ...manifest,
      description: "PwrGit placeholder package",
      main: "index.js",
      dependencies: { electron: "latest" },
    };

    expect(checkReservationManifest(misleading, readme)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("package description"),
        'package must not declare "dependencies"',
        'package must not declare "main"',
      ]),
    );
  });

  it("rejects executable files in the published tarball", () => {
    expect(checkPackedFiles(["LICENSE", "README.md", "package.json", "index.js"])).toEqual([
      expect.stringContaining("index.js"),
    ]);
  });
});
