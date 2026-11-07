import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { checkPackageLicensePolicy } from "./check-package-license-policy.mjs";
import { applyVariant, textVariant } from "./test-support/line-endings.mjs";

const OWNER = "PwrDrvr LLC";
const COPYRIGHT = `Copyright © 2026 ${OWNER}`;
const PACKAGES = [
  "package.json",
  "apps/desktop/package.json",
  "packages/mcp-server/package.json",
  "packages/pwrgit/package.json",
  "packages/shared/package.json",
];

const root = mkdtempSync(join(tmpdir(), "pwrgit-license-policy-property-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every file the policy reads, keyed by path; `broken` makes one of them wrong. */
function files(broken) {
  const contents = {};
  for (const path of PACKAGES) {
    const packageJson = { name: path, private: true, author: OWNER, license: "MIT", copyright: COPYRIGHT };
    if (broken === path) packageJson.license = "ISC";
    contents[path] = `${JSON.stringify(packageJson, null, 2)}\n`;
  }
  contents.LICENSE =
    broken === "LICENSE" ? "ISC License\n" : `MIT License\n\nCopyright (c) 2026 ${OWNER}\n`;
  contents["apps/desktop/electron-builder.yml"] = [
    `copyright: "${COPYRIGHT}."`,
    `NSHumanReadableCopyright: "${COPYRIGHT}."`,
    broken === "apps/desktop/electron-builder.yml" ? "maintainer: someone" : `maintainer: ${OWNER}`,
    "",
  ].join("\n");
  return contents;
}

function writeTree(contents, variants = {}) {
  for (const [path, text] of Object.entries(contents)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, applyVariant(variants[path] ?? "identity", text));
  }
}

const PATHS = Object.keys(files());

describe("package license policy (property)", () => {
  it("reaches the same verdict however each file's line endings, BOM and final newline are written", () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...PATHS), { nil: undefined }),
        fc.record(Object.fromEntries(PATHS.map((path) => [path, textVariant()]))),
        (broken, variants) => {
          const contents = files(broken);
          writeTree(contents);
          const expected = checkPackageLicensePolicy(root);
          writeTree(contents, variants);
          expect(checkPackageLicensePolicy(root)).toEqual(expected);
        },
      ),
    );
  });
});

describe("package license policy (shrunk counterexamples)", () => {
  it("reads a package.json that starts with a byte-order mark", () => {
    // JSON.parse threw on the BOM; npm and pnpm accept one.
    writeTree(files(), { "packages/shared/package.json": "bom" });
    expect(checkPackageLicensePolicy(root)).toEqual([]);
  });

  it("reads a LICENSE that starts with a byte-order mark", () => {
    writeTree(files(), { LICENSE: "bom" });
    expect(checkPackageLicensePolicy(root)).toEqual([]);
  });
});
