import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { audit, compareVersions, distribution, prepare, renderManifests, selectAssets, stableVersion } from "./package-manager-release.mjs";

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
    if (path.startsWith("search/code")) return { total_count: duplicate ? 1 : 0, items: duplicate ? [{ path: "manifests/o/Other/PwrGit/1.0.0/file.yaml" }] : [] };
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

test("inspects later identity-search pages before allowing submission", async () => {
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ path: `${distribution.wingetPath}/0.${i}.0/file.yaml` }));
  const source = api();
  const pages = [];
  const paginated = (path) => {
    if (!path.startsWith("search/code")) return source(path);
    const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
    pages.push(page);
    return { total_count: 101, incomplete_results: false, items: page === 1 ? firstPage : [{ path: "manifests/o/Other/PwrGit/1.0.0/file.yaml" }] };
  };
  await expect(audit({ api: paginated })).rejects.toThrow("Another Winget identity");
  expect(pages).toEqual([1, 2]);
  const result = await audit({ api: (path) => {
    const response = paginated(path);
    if (path.startsWith("search/code") && path.endsWith("page=2")) response.items = [{ path: `${distribution.wingetPath}/0.100.0/file.yaml` }];
    return response;
  } });
  expect(result.winget.version).toBeNull();
});

test.each([
  { total_count: 31, incomplete_results: false, items: Array.from({ length: 30 }, (_, i) => ({ path: `${distribution.wingetPath}/0.${i}.0/file.yaml` })) },
  { total_count: 1001, incomplete_results: false, items: [] },
  { total_count: 0, incomplete_results: true, items: [] },
])("rejects uninspectable identity results %#", async (response) => {
  const source = api();
  await expect(audit({ api: (path) => path.startsWith("search/code") ? response : source(path) })).rejects.toThrow("identity search was incomplete");
});

test("removes interrupted or corrupt downloads and retries without poisoning the cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-distribution-test-"));
  const value = release();
  const payloads = value.assets.map((asset) => Buffer.from(`complete ${asset.name}`));
  value.assets.forEach((asset, i) => {
    asset.size = payloads[i].length;
    asset.digest = `sha256:${createHash("sha256").update(payloads[i]).digest("hex")}`;
  });
  const sumsUrl = "https://example.com/checksums";
  value.assets.push({ name: "PwrGit-windows-SHA256SUMS", browser_download_url: sumsUrl });
  const source = api();
  const releaseApi = (path) => path.includes("/releases/") ? value : source(path);
  const requests = [];
  let interrupted = true;
  let corrupt = true;
  const fetchAsset = async (url) => {
    requests.push(url);
    if (interrupted) {
      interrupted = false;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from("partial bytes"));
          setTimeout(() => controller.error(new Error("connection interrupted")), 10);
        },
      }));
    }
    if (corrupt) {
      corrupt = false;
      return new Response("incorrect bytes");
    }
    if (url === sumsUrl) return new Response(`${value.assets[2].digest.slice(7)}  ${value.assets[2].name}`);
    return new Response(payloads[value.assets.findIndex((asset) => asset.browser_download_url === url)]);
  };
  try {
    await expect(prepare(value.tag_name, directory, { api: releaseApi, fetch: fetchAsset })).rejects.toThrow("connection interrupted");
    expect(readdirSync(join(directory, "downloads"))).toEqual([]);
    await expect(prepare(value.tag_name, directory, { api: releaseApi, fetch: fetchAsset })).rejects.toThrow("Downloaded bytes do not match GitHub");
    expect(readdirSync(join(directory, "downloads"))).toEqual([]);
    await prepare(value.tag_name, directory, { api: releaseApi, fetch: fetchAsset });
    expect(requests.filter((url) => url === value.assets[0].browser_download_url)).toHaveLength(3);
    expect(readFileSync(join(directory, "downloads", value.assets[0].name))).toEqual(payloads[0]);
    expect(readdirSync(join(directory, "downloads"))).toHaveLength(3);
    const previousRequests = requests.length;
    await prepare(value.tag_name, directory, { api: releaseApi, fetch: fetchAsset });
    expect(requests.slice(previousRequests)).toEqual([sumsUrl]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
