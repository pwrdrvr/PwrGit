import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { applyVariant, semver, textVariant } from "../../../scripts/test-support/line-endings.mjs";
import {
  LINUX_ARCHITECTURES,
  LINUX_FORMATS,
  linuxArtifactName,
  linuxManifestName,
  writeLinuxReleaseArtifacts,
} from "./linux-release-artifacts.mjs";

// The reader of these manifests is electron-updater, on users' machines. Use
// its own parser as the oracle, not a YAML library of our choosing.
const require = createRequire(import.meta.url);
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");

const root = mkdtempSync(join(tmpdir(), "pwrgit-linux-manifest-property-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let runs = 0;

const payload = fc.uint8Array({ minLength: 1, maxLength: 64 });

function readAs(dist, name, variant) {
  const text = applyVariant(variant, readFileSync(join(dist, name), "utf8"));
  return parseUpdateInfo(text, name, new URL(`https://example.test/${name}`));
}

describe("latest-linux*.yml (property)", () => {
  test("electron-updater reads back each latest-linux*.yml we write, in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(
        semver,
        fc.constantFrom(...LINUX_ARCHITECTURES),
        fc.array(payload, { minLength: LINUX_FORMATS.length, maxLength: LINUX_FORMATS.length }),
        textVariant(),
        (version, arch, packages, variant) => {
          const dist = join(root, `linux-${runs++}`);
          mkdirSync(dist);
          LINUX_FORMATS.forEach((format, i) => {
            writeFileSync(join(dist, linuxArtifactName(version, arch, format)), packages[i]);
          });
          const manifest = writeLinuxReleaseArtifacts(dist, version, arch);
          expect(readAs(dist, linuxManifestName(arch), variant)).toEqual(manifest);
        },
      ),
      // Each run writes, hashes and copies real files (~7 ms here, more on
      // Windows CI); 30 runs covers the version and variant space.
      { numRuns: 30 },
    );
  });
});
