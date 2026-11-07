import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { distribution, renderManifests, selectAssets } from "../package-manager-release.mjs";
import { applyVariant, textVariant } from "../test-support/line-endings.mjs";
import { syncHomebrew } from "./sync-homebrew.mjs";

const version = fc
  .tuple(fc.nat({ max: 30 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
  .map((parts) => parts.join("."));

function cask(value) {
  const tag_name = `v${value}`;
  const release = {
    tag_name, draft: false, prerelease: false,
    assets: ["arm64.dmg", "universal.dmg", "windows-x64-setup.exe"].map((suffix) => {
      const name = `PwrGit-${value}-${suffix}`;
      return {
        name,
        browser_download_url: `https://github.com/${distribution.repo}/releases/download/${tag_name}/${name}`,
        size: 1,
        digest: `sha256:${"a".repeat(64)}`,
      };
    }),
  };
  return renderManifests(release, selectAssets(release), ":ventura")["Casks/pwrgit.rb"];
}

describe("Homebrew sync (property)", () => {
  test("sees a published cask as published in any line-ending, BOM or final-newline form", async () => {
    await fc.assert(
      fc.asyncProperty(version, textVariant(), async (value, variant) => {
        const calls = [];
        const api = async (endpoint, body) => {
          calls.push(endpoint);
          if (body) throw new Error("must not dispatch for a published cask");
          if (endpoint.includes("releases/latest")) return { tag_name: `v${value}`, draft: false, prerelease: false };
          if (endpoint.includes("contents/")) {
            return { content: Buffer.from(applyVariant(variant, cask(value))).toString("base64") };
          }
          throw new Error(`unexpected ${endpoint}`);
        };
        expect(await syncHomebrew(value, { api, dispatchToken: "" })).toMatchObject({ state: "published" });
        expect(calls).toHaveLength(2);
      }),
    );
  });
});
