import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkFirstPartyNamePolicy,
  checkPackageLicensePolicy,
} from "./check-package-license-policy.mjs";

const OWNER = "PwrDrvr LLC";
const COPYRIGHT = `Copyright © 2026 ${OWNER}`;
const roots = [];

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writePackage(path, extra = {}) {
  write(
    path,
    `${JSON.stringify(
      {
        name: path,
        private: true,
        author: OWNER,
        license: "MIT",
        copyright: COPYRIGHT,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function createValidRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-license-policy-"));
  roots.push(root);
  writePackage(join(root, "package.json"));
  writePackage(join(root, "apps", "desktop", "package.json"));
  writePackage(join(root, "packages", "pwrgit", "package.json"));
  writePackage(join(root, "packages", "shared", "package.json"));
  write(
    join(root, "LICENSE"),
    `MIT License\n\nCopyright (c) 2026 ${OWNER}\n`,
  );
  write(
    join(root, "apps", "desktop", "electron-builder.yml"),
    [
      `copyright: "${COPYRIGHT}."`,
      `NSHumanReadableCopyright: "${COPYRIGHT}."`,
      `maintainer: ${OWNER}`,
      "",
    ].join("\n"),
  );
  return root;
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("package license policy", () => {
  it("accepts complete MIT and first-party ownership metadata", () => {
    const root = createValidRoot();
    expect(checkPackageLicensePolicy(root)).toEqual([]);
  });

  it("accepts a Windows CRLF checkout of the MIT license", () => {
    const root = createValidRoot();
    const licensePath = join(root, "LICENSE");
    const license = readFileSync(licensePath, "utf8").replace(/\n/g, "\r\n");
    writeFileSync(licensePath, license);

    expect(checkPackageLicensePolicy(root)).toEqual([]);
  });

  it("reports missing or incorrect first-party ownership metadata", () => {
    const root = createValidRoot();
    const packagePath = join(root, "packages", "shared", "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    delete packageJson.copyright;
    packageJson.author = "Unrelated Company";
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(checkPackageLicensePolicy(root)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("declares author"),
        expect.stringContaining("declares copyright"),
      ]),
    );
  });
});

describe("first-party name policy", () => {
  it("rejects prohibited names in tracked files", () => {
    const root = createValidRoot();
    runGit(root, ["init", "--quiet"]);
    write(join(root, "README.md"), "first-party project\n");
    runGit(root, ["add", "."]);

    for (const name of [
      ["gi", "phy"].join(""),
      ["ss", "tk"].join(""),
    ]) {
      write(join(root, "README.md"), `${name}\n`);
      expect(checkFirstPartyNamePolicy(root)).toEqual([
        expect.stringContaining("README.md:1"),
      ]);
    }
  });

  it("limits the public dependency vendor name when Git color is forced", () => {
    const root = createValidRoot();
    runGit(root, ["init", "--quiet"]);
    const vendor = ["shutter", "stock"].join("");
    writePackage(join(root, "apps", "desktop", "package.json"), {
      dependencies: { [`@${vendor}/p-map-iterable`]: "1.1.2" },
    });
    write(join(root, "README.md"), "first-party project\n");
    runGit(root, ["add", "."]);
    runGit(root, ["config", "color.grep", "always"]);
    expect(checkFirstPartyNamePolicy(root)).toEqual([]);

    write(join(root, "README.md"), `${vendor}\n`);
    expect(checkFirstPartyNamePolicy(root)).toEqual([
      expect.stringContaining("README.md:1"),
    ]);
  });
});
