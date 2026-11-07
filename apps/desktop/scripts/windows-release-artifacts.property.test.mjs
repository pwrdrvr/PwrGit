import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { BOM, applyVariant, semver, textVariant } from "../../../scripts/test-support/line-endings.mjs";
import {
  formatWindowsChecksums,
  installerName,
  parseWindowsChecksums,
  WINDOWS_ALIAS_NAMES,
} from "./windows-release-artifacts.mjs";

const digest = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString("hex"));

// Installer names as packaging produces them, plus other names a Windows
// directory can hold: spaces, dots, brackets, but never a line break.
const fileName = fc.oneof(
  fc.tuple(semver, fc.constantFrom(...Object.keys(WINDOWS_ALIAS_NAMES))).map(([version, arch]) =>
    installerName(version, arch),
  ),
  fc
    .array(fc.constantFrom(..."abcXYZ019 .-_()[]+~"), { minLength: 1, maxLength: 24 })
    .map((chars) => chars.join(""))
    .filter((name) => name.trim() !== ""),
);

const manifest = fc.uniqueArray(fc.record({ name: fileName, sha256: digest }), {
  selector: (entry) => entry.name,
  maxLength: 6,
});

describe("SHA256SUMS (property)", () => {
  test("reads back exactly what it wrote, however the file's line endings, BOM and final newline end up", () => {
    fc.assert(
      fc.property(manifest, textVariant(), (entries, variant) => {
        const text = applyVariant(variant, formatWindowsChecksums(entries));
        expect(parseWindowsChecksums(text)).toEqual(
          new Map(entries.map(({ name, sha256 }) => [name, sha256])),
        );
      }),
    );
  });
});

describe("SHA256SUMS (shrunk counterexamples)", () => {
  test("reads a manifest that starts with a byte-order mark", () => {
    // Before parseWindowsChecksums stripped it, the BOM made the first line
    // "malformed" and the signing job refused every alias.
    const hash = "a".repeat(64);
    const name = installerName("1.2.3", "x64");
    expect(parseWindowsChecksums(`${BOM}${hash}  ${name}\r\n`)).toEqual(new Map([[name, hash]]));
  });
});
