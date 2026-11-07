import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  caskMacosRequirement,
  distribution,
  readCask,
  readWingetInstaller,
  renderManifests,
  selectAssets,
} from "./package-manager-release.mjs";
import { applyVariant, BOM, textVariant, toCrlf } from "./test-support/line-endings.mjs";

const electronBuilder = readFileSync(new URL("../apps/desktop/electron-builder.yml", import.meta.url), "utf8");

const digest = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => `sha256:${Buffer.from(bytes).toString("hex")}`);

/** A promoted Stable Latest release with its three signed installers. */
const stableRelease = fc
  .record({
    version: fc
      .tuple(fc.nat({ max: 30 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
      .map((parts) => parts.join(".")),
    digests: fc.tuple(digest, digest, digest),
  })
  .map(({ version, digests }) => {
    const tag_name = `v${version}`;
    return {
      tag_name,
      draft: false,
      prerelease: false,
      assets: ["arm64.dmg", "universal.dmg", "windows-x64-setup.exe"].map((suffix, i) => {
        const name = `PwrGit-${version}-${suffix}`;
        return {
          name,
          browser_download_url: `https://github.com/${distribution.repo}/releases/download/${tag_name}/${name}`,
          size: 123,
          digest: digests[i],
        };
      }),
    };
  });

const installerPath = (version) =>
  `${distribution.wingetPath}/${version}/${distribution.wingetId}.installer.yaml`;

describe("package manager manifests (property)", () => {
  it("reads back the cask it renders, in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(stableRelease, textVariant(), (release, variant) => {
        const [arm64, universal] = selectAssets(release);
        const cask = renderManifests(release, selectAssets(release), ":ventura")["Casks/pwrgit.rb"];
        expect(readCask(applyVariant(variant, cask))).toEqual({
          version: release.tag_name.slice(1),
          assets: [
            { architecture: "arm64", url: arm64.browser_download_url, digest: arm64.digest },
            { architecture: "universal", url: universal.browser_download_url, digest: universal.digest },
          ],
        });
      }),
    );
  });

  it("reads back the Winget installer manifest it renders, in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(stableRelease, textVariant(), (release, variant) => {
        const version = release.tag_name.slice(1);
        const windows = selectAssets(release)[2];
        const installer = renderManifests(release, selectAssets(release), ":ventura")[installerPath(version)];
        expect(readWingetInstaller(applyVariant(variant, installer), version)).toEqual([
          { architecture: "x64", url: windows.browser_download_url, digest: windows.digest },
        ]);
      }),
    );
  });

  it("derives the same macOS floor from electron-builder.yml in any line-ending, BOM or final-newline form", () => {
    const floors = { 12: ":monterey", 13: ":ventura", 14: ":sonoma", 15: ":sequoia", 26: ":tahoe" };
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(floors)),
        fc.constantFrom('"', ""),
        fc.constantFrom("", ".0"),
        fc.boolean(),
        textVariant(),
        (major, quote, minor, comment, variant) => {
          const config = electronBuilder.replace(
            /^( *LSMinimumSystemVersion:).*$/m,
            `$1 ${quote}${major}${minor}${quote}${comment ? " # macOS floor" : ""}`,
          );
          expect(caskMacosRequirement(applyVariant(variant, config))).toBe(floors[major]);
        },
      ),
    );
  });
});

describe("package manager manifests (shrunk counterexamples)", () => {
  const release = {
    tag_name: "v0.0.0",
    draft: false,
    prerelease: false,
    assets: ["arm64.dmg", "universal.dmg", "windows-x64-setup.exe"].map((suffix) => {
      const name = `PwrGit-0.0.0-${suffix}`;
      return {
        name,
        browser_download_url: `https://github.com/${distribution.repo}/releases/download/v0.0.0/${name}`,
        size: 1,
        digest: `sha256:${"0".repeat(64)}`,
      };
    }),
  };
  const files = renderManifests(release, selectAssets(release), ":ventura");

  it("reads a cask that starts with a byte-order mark", () => {
    // Shrunk from the property: readCask matched `cask "pwrgit" do\n` at the
    // start of the file, so a BOM read as "cask layout changed".
    expect(readCask(`${BOM}${files["Casks/pwrgit.rb"]}`).version).toBe("0.0.0");
  });

  it("reads a CRLF cask", () => {
    // Its one caller normalized CRLF first; the reader itself did not.
    expect(readCask(toCrlf(files["Casks/pwrgit.rb"])).version).toBe("0.0.0");
  });
});
