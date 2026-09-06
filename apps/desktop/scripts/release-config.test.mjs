import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("desktop release configuration", () => {
  test("macOS signing preloads a generated-password keychain", () => {
    const script = read("apps/desktop/scripts/release.mjs");

    // electron-builder 26.15.x passes CSC_KEY_PASSWORD (the .p12 password) to
    // set-key-partition-list for its own random-password keychain. Keep the
    // imported identity first in the user search list instead, then remove the
    // import variables before electron-builder can recreate that keychain.
    expect(script).toContain("maybePrepareCodesignKeychain");
    expect(script).toContain('"set-key-partition-list"');
    expect(script).toContain("keychainPassword,");
    expect(script).toMatch(
      /"list-keychains",\s+"-d",\s+"user",\s+"-s",\s+keychainPath,/,
    );
    expect(script).toContain('"delete-keychain", keychainPath');
    expect(script).toContain("using preloaded Developer ID keychain");
    expect(script).toContain("delete process.env.CSC_LINK");
    expect(script).toContain("delete process.env.CSC_KEY_PASSWORD");
    expect(script).not.toContain("process.env.CSC_KEYCHAIN");
    expect(script).toContain('if (preceding === "-p" || preceding === "-P") return "***";');

    const setup = script.indexOf("maybePrepareCodesignKeychain()");
    const clearLink = script.indexOf("delete process.env.CSC_LINK", setup);
    expect(setup).toBeGreaterThan(-1);
    expect(clearLink).toBeGreaterThan(setup);
  });

  test("local dry-runs do not preload signing credentials", () => {
    const script = read("apps/desktop/scripts/release.mjs");

    expect(script).toContain(
      "if (!dryrun) {\n    maybeDecodeCscLink();\n    if (maybePrepareCodesignKeychain()) {",
    );
  });

  test("sign-stage-only reaches the shared macOS signing setup", () => {
    const script = read("apps/desktop/scripts/release.mjs");

    const stagedInputCheck = script.indexOf("} else if (!existsSync(stageDir))");
    const keychainSetup = script.lastIndexOf("if (maybePrepareCodesignKeychain())");
    expect(stagedInputCheck).toBeGreaterThan(-1);
    expect(keychainSetup).toBeGreaterThan(stagedInputCheck);
  });
});
