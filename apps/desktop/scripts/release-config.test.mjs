import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

// Execute the signing helpers without the top-level packaging pipeline. Every
// security call and exit event stays in this sandbox; no real keys are touched.
function signingHarness({ password, failAt, missingIdentity = false } = {}) {
  const script = read("apps/desktop/scripts/release.mjs");
  const calls = [];
  const exits = [];
  const env = { CSC_LINK: "/fixtures/requested.p12" };
  if (password !== undefined) env.CSC_KEY_PASSWORD = password;
  const context = {
    process: { platform: "darwin", pid: 123, env, once: (_, fn) => exits.push(fn) },
    join, fileURLToPath, pathToFileURL,
    tmpdir: () => "/fixture-tmp",
    existsSync: () => true,
    console: { log() {} },
    runQuiet: (_, args) => {
      calls.push(args);
      if (args[0] === failAt) throw new Error(`simulated ${failAt} failure`);
      if (args[0] === "list-keychains" && !args.includes("-s")) {
        return '"/fixtures/login.keychain-db"\n';
      }
      if (args[0] === "find-identity") {
        if (args.length === 4) return '"Developer ID Application: Unrelated Team (OTHER)"';
        return missingIdentity ? "0 valid identities found" : '"Developer ID Application: Requested Team (REQUESTED)"';
      }
      return "";
    },
  };
  const helpers = script.slice(script.indexOf("function parseSecurityKeychains("), script.indexOf("function electronBuilderCli("));
  const setup = script.slice(script.indexOf("function maybePrepareCodesignKeychain("), script.indexOf("\nif (!signStageOnly)"));
  const prepare = runInNewContext(`let codesignKeychainCleanup = null;\n${helpers}\n${setup}\nmaybePrepareCodesignKeychain`, context);
  return { prepare, calls, env, exit: () => exits.forEach((fn) => fn()) };
}

describe("macOS signing keychain behavior", () => {
  test("imports the requested certificate even when another team is already available", () => {
    const harness = signingHarness({ password: "export-password" });
    expect(harness.prepare()).toBe(true);
    const imported = harness.calls.find(([command]) => command === "import");
    expect(imported[1]).toBe("/fixtures/requested.p12");
    expect(imported[imported.indexOf("-P") + 1]).toBe("export-password");
    expect(harness.env.CSC_NAME).toBe("Requested Team (REQUESTED)");
    const created = harness.calls.find(([command]) => command === "create-keychain");
    const partition = harness.calls.find(([command]) => command === "set-key-partition-list");
    expect(partition[partition.indexOf("-k") + 1]).toBe(created[2]);
    expect(partition[partition.indexOf("-k") + 1]).not.toBe("export-password");
    harness.exit();
    expect(harness.calls.slice(-2)).toEqual([
      ["list-keychains", "-d", "user", "-s", "/fixtures/login.keychain-db"],
      ["delete-keychain", created[3]],
    ]);
  });

  test.each([undefined, ""])("accepts an empty certificate password (%s)", (password) => {
    const harness = signingHarness({ password });
    expect(harness.prepare()).toBe(true);
    const imported = harness.calls.find(([command]) => command === "import");
    expect(imported[imported.indexOf("-P") + 1]).toBe("");
    harness.exit();
  });

  test.each(["set-keychain-settings", "unlock-keychain", "import", "set-key-partition-list", "find-identity"])(
    "restores the search list and deletes the keychain on exit after %s fails",
    (failAt) => {
      const harness = signingHarness({ failAt });
      expect(harness.prepare).toThrow(`simulated ${failAt} failure`);
      harness.exit();
      const created = harness.calls.find(([command]) => command === "create-keychain");
      expect(harness.calls.slice(-2)).toEqual([
        ["list-keychains", "-d", "user", "-s", "/fixtures/login.keychain-db"],
        ["delete-keychain", created[3]],
      ]);
    },
  );

  test("cleans up when the imported certificate has no usable identity", () => {
    const harness = signingHarness({ missingIdentity: true });
    expect(harness.prepare).toThrow("no Developer ID Application identity was found");
    harness.exit();
    expect(harness.calls.at(-1)[0]).toBe("delete-keychain");
  });
});

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
