import { expect, test } from "vitest";
import { audit, compareVersions, distribution, renderManifests, selectAssets, stableVersion } from "./package-manager-release.mjs";

function release() {
  const tag_name = "v0.27.0";
  return {
    tag_name, draft: false, prerelease: false,
    assets: ["arm64.dmg", "universal.dmg", "windows-x64-setup.exe"].map((suffix, i) => {
      const name = `PwrGit-0.27.0-${suffix}`;
      return { name, browser_download_url: `https://github.com/pwrdrvr/PwrGit/releases/download/${tag_name}/${name}`, size: 123, digest: `sha256:${String(i + 1).repeat(64)}` };
    }),
  };
}

function api({ winget = null, cask = null, central = null, duplicate = false, pending = [] } = {}) {
  return (path) => {
    if (path.endsWith("/releases/latest")) return release();
    if (path.endsWith(distribution.wingetPath)) return winget?.map((name) => ({ name })) ?? null;
    if (path.includes("homebrew-tap/contents")) return cask ? { content: Buffer.from(`  version "${cask}"\n`).toString("base64") } : null;
    if (path.includes("homebrew-cask/contents")) return central;
    if (path.startsWith("search/code")) return { items: duplicate ? [{ path: "manifests/o/Other/PwrGit/1.0.0/file.yaml" }] : [] };
    if (path.startsWith("search/issues")) return { items: pending };
    throw new Error(`Unexpected API request: ${path}`);
  };
}

test.each([
  { ...release(), prerelease: true }, { ...release(), draft: true },
  { ...release(), tag_name: "v0.28.0-beta.1" }, { ...release(), tag_name: "v0.28.0\nevil" },
])("rejects a release that is not promoted stable %#", (value) => {
  expect(() => stableVersion(value)).toThrow("Stable Latest");
});

test("requires signed versioned assets, exact URLs, digests and sizes", () => {
  const value = release();
  expect(selectAssets(value)).toHaveLength(3);
  value.assets[2].name = "PwrGit-0.27.0-windows-x64-unsigned-setup.exe";
  expect(() => selectAssets(value)).toThrow("signed versioned asset");
  value.assets = release().assets;
  value.assets[0].browser_download_url = "https://example.com/app.dmg";
  expect(() => selectAssets(value)).toThrow("Invalid URL");
  value.assets = release().assets;
  value.assets[0].digest = null;
  expect(() => selectAssets(value)).toThrow("digest");
  value.assets = release().assets;
  value.assets.push(value.assets[0]);
  expect(() => selectAssets(value)).toThrow("Expected one");
});

test("orders multi-digit versions numerically", () => {
  expect(["0.9.0", "0.10.0", "0.27.0"].sort(compareVersions).at(-1)).toBe("0.27.0");
});

test("reports missing registration and pending links without claiming publication", async () => {
  const result = await audit({ api: api({ pending: [{ html_url: "https://github.com/example/pull/1", title: "PwrGit" }] }) });
  expect(result.winget.version).toBeNull();
  expect(result.homebrew.version).toBeNull();
  expect(result.submissions.winget[0].url).toContain("/pull/1");
  expect(result.clientPublication).toContain("Verify");
});

test("compares authoritative versions and refuses downgrades or duplicates", async () => {
  const result = await audit({ api: api({ winget: ["0.9.0", "0.27.0"], cask: "0.27.0" }) });
  expect(result.winget.version).toBe("0.27.0");
  await expect(audit({ api: api({ winget: ["0.28.0"] }) })).rejects.toThrow("downgrade");
  await expect(audit({ api: api({ cask: "0.28.0" }) })).rejects.toThrow("downgrade");
  await expect(audit({ api: api({ duplicate: true }) })).rejects.toThrow("Another Winget identity");
  await expect(audit({ api: api({ central: {} }) })).rejects.toThrow("reconcile");
});

test("preserves errors from remote sources", async () => {
  await expect(audit({ api: () => { throw new Error("HTTP 403"); } })).rejects.toThrow("HTTP 403");
});

test("awaits remote source lookups, including delayed searches", async () => {
  const source = api({ winget: ["0.27.0"], cask: "0.27.0" });
  const result = await audit({ api: async (...args) => source(...args) });
  expect(result.winget.version).toBe("0.27.0");
  expect(result.homebrew.version).toBe("0.27.0");
});

test("maps native arm64 and universal Intel DMGs separately and offers only Windows x64", () => {
  const value = release();
  const output = renderManifests(value, selectAssets(value));
  expect(output["Casks/pwrgit.rb"]).toContain('arch arm: "arm64", intel: "universal"');
  expect(output["Casks/pwrgit.rb"]).toContain(`sha256 arm:   "${"1".repeat(64)}"`);
  expect(output["Casks/pwrgit.rb"]).toContain(`intel: "${"2".repeat(64)}"`);
  const installer = output[`${distribution.wingetPath}/0.27.0/PwrDrvr.PwrGit.installer.yaml`];
  expect(installer).toContain("Architecture: x64");
  expect(installer).toContain("Custom: /currentuser");
  expect(installer).toContain(`InstallerSha256: ${"3".repeat(64)}`);
  expect(installer).not.toContain("Architecture: arm64");
  expect(installer).not.toContain("/latest/");
});
