import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkPackageLicensePolicy } from "./check-package-license-policy.mjs";

const temporaryRoots = [];

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-license-policy-"));
  temporaryRoots.push(root);
  return root;
}

function writePackage(root, relativePath, license) {
  const packagePath = join(root, relativePath);
  mkdirSync(dirname(packagePath), { recursive: true });
  writeFileSync(packagePath, JSON.stringify({ license }));
}

function writeExpectedPackages(root) {
  writePackage(root, "package.json", "MIT");
  writePackage(root, "apps/desktop/package.json", "MIT");
  writePackage(root, "packages/shared/package.json", "MIT");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("checkPackageLicensePolicy", () => {
  it("accepts the complete MIT workspace policy", () => {
    const root = makeTemporaryRoot();
    writeExpectedPackages(root);

    expect(checkPackageLicensePolicy(root)).toEqual([]);
  });

  it("reports a covered package whose license drifts", () => {
    const root = makeTemporaryRoot();
    writeExpectedPackages(root);
    writePackage(root, "apps/desktop/package.json", "UNLICENSED");

    expect(checkPackageLicensePolicy(root)).toContain(
      'apps/desktop/package.json declares license "UNLICENSED"; expected "MIT"',
    );
  });

  it("requires an explicit policy entry for a new workspace package", () => {
    const root = makeTemporaryRoot();
    writeExpectedPackages(root);
    writePackage(root, "packages/new-package/package.json", "MIT");

    expect(checkPackageLicensePolicy(root)).toContain(
      "packages/new-package/package.json is not covered by scripts/check-package-license-policy.mjs; add an explicit expected license",
    );
  });
});
