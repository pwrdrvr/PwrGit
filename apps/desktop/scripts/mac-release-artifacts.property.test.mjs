import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { applyVariant, semver, textVariant } from "../../../scripts/test-support/line-endings.mjs";
import { MAC_ARCHITECTURES, writeMacReleaseArtifacts } from "./mac-release-artifacts.mjs";

// The reader of these manifests is electron-updater, on users' machines. Use
// its own parser as the oracle, not a YAML library of our choosing.
const require = createRequire(import.meta.url);
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");

const root = mkdtempSync(join(tmpdir(), "pwrgit-updater-manifest-property-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let runs = 0;

const payload = fc.uint8Array({ minLength: 1, maxLength: 64 });

function readAs(dist, name, variant) {
  const text = applyVariant(variant, readFileSync(join(dist, name), "utf8"));
  return parseUpdateInfo(text, name, new URL(`https://example.test/${name}`));
}

describe("latest-mac.yml (property)", () => {
  test("electron-updater reads back the latest-mac.yml we write, in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(
        semver,
        fc.tuple(payload, payload),
        textVariant(),
        (version, zips, variant) => {
          const dist = join(root, `mac-${runs++}`);
          mkdirSync(dist);
          MAC_ARCHITECTURES.forEach((arch, i) => {
            writeFileSync(join(dist, `PwrGit-${version}-${arch}-mac.zip`), zips[i]);
            writeFileSync(join(dist, `PwrGit-${version}-${arch}-mac.zip.blockmap`), "map");
            writeFileSync(join(dist, `PwrGit-${version}-${arch}.dmg`), "dmg");
          });
          const manifest = writeMacReleaseArtifacts(dist, version);
          expect(readAs(dist, "latest-mac.yml", variant)).toEqual(manifest);
        },
      ),
      // Each run writes, hashes and copies real files (~7 ms here, more on
      // Windows CI); 30 runs covers the version and variant space.
      { numRuns: 30 },
    );
  });
});
