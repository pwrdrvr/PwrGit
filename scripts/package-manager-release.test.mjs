import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { audit, compareVersions, distribution, downloadPlatform, prepare, publicationFailures, readCask, readWingetInstaller, renderManifests, selectAssets, stableVersion, validationPlan } from "./package-manager-release.mjs";

function release(version = "0.27.0") {
  const tag_name = `v${version}`;
  return {
    tag_name, draft: false, prerelease: false,
    assets: ["arm64.dmg", "universal.dmg", "windows-x64-setup.exe"].map((suffix, i) => {
      const name = `PwrGit-${version}-${suffix}`;
      return { name, browser_download_url: `https://github.com/pwrdrvr/PwrGit/releases/download/${tag_name}/${name}`, size: 123, digest: `sha256:${String(i + 1).repeat(64)}` };
    }),
  };
}

function api({ winget = null, cask = null, central = null, duplicate = false, pending = [] } = {}) {
  return (path) => {
    if (/^repos\/[^/]+\/[^/?]+$/.test(path)) return { private: false, default_branch: path.includes("winget-pkgs") ? "master" : "main" };
    if (path.endsWith("/releases/latest")) return release();
    if (path.includes("/releases/tags/")) return release(path.match(/\/releases\/tags\/v(\d+\.\d+\.\d+)/)?.[1]);
    if (path.includes(`${distribution.wingetPath}?`)) return winget?.map((name) => ({ name })) ?? null;
    const content = (text) => ({ encoding: "base64", content: Buffer.from(text).toString("base64") });
    if (path.includes("homebrew-tap/contents")) {
      if (!cask) return null;
      const value = release();
      value.tag_name = `v${cask}`;
      return content(renderManifests(value, selectAssets(release()))["Casks/pwrgit.rb"]);
    }
    if (path.includes(".installer.yaml")) {
      const version = path.match(/\/(\d+\.\d+\.\d+)\//)?.[1];
      const value = release(version);
      return content(renderManifests(value, selectAssets(value))[`${distribution.wingetPath}/${version}/${distribution.wingetId}.installer.yaml`]);
    }
    if (path.startsWith("search/code")) {
      const items = path.includes("winget-pkgs") ? (duplicate ? [{ path: "manifests/o/Other/PwrGit/1.0.0/file.yaml" }] : []) : (central ? [{ path: "Casks/p/pwrgit.rb" }] : []);
      return { total_count: items.length, incomplete_results: false, items };
    }
    if (path.startsWith("search/issues")) return { total_count: pending.length, incomplete_results: false, items: pending };
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

test("audits published platform manifests using metadata without fetching release bytes", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Audit must not download release bytes"); });
  try {
    const result = await audit({ api: api({ winget: ["0.27.0"], cask: "0.27.0" }) });
    expect(result.status).toBe("complete");
    expect(result.winget.version).toBe("0.27.0");
    expect(result.homebrew.version).toBe("0.27.0");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
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
  const source = api({ winget: ["0.27.0"] });
  const pages = [];
  const paginated = (path) => {
    if (!path.startsWith("search/code") || !path.includes("winget-pkgs")) return source(path);
    const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
    pages.push(page);
    return { total_count: 101, incomplete_results: false, items: page === 1 ? firstPage : [{ path: "manifests/o/Other/PwrGit/1.0.0/file.yaml" }] };
  };
  await expect(audit({ api: paginated })).rejects.toThrow("Another Winget identity");
  expect(pages).toEqual([1, 2]);
  const result = await audit({ api: (path) => {
    const response = paginated(path);
    if (path.startsWith("search/code") && path.includes("winget-pkgs") && path.endsWith("page=2")) response.items = [{ path: `${distribution.wingetPath}/0.100.0/file.yaml` }];
    return response;
  } });
  expect(result.winget.version).toBe("0.27.0");
});

test.each([
  { total_count: 31, incomplete_results: false, items: Array.from({ length: 30 }, (_, i) => ({ path: `${distribution.wingetPath}/0.${i}.0/file.yaml` })) },
  { total_count: 1001, incomplete_results: false, items: [] },
  { total_count: 0, incomplete_results: true, items: [] },
])("rejects uninspectable identity results %#", async (response) => {
  const source = api();
  await expect(audit({ api: (path) => path.startsWith("search/code") && path.includes("winget-pkgs") ? response : source(path) })).rejects.toThrow(/search/);
});

test("removes interrupted or corrupt downloads and retries without poisoning the cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-distribution-test-"));
  const value = release();
  const payloads = value.assets.map((asset) => Buffer.from(`complete ${asset.name}`));
  value.assets.forEach((asset, i) => {
    asset.size = payloads[i].length;
    asset.digest = `sha256:${createHash("sha256").update(payloads[i]).digest("hex")}`;
  });
  const sumsUrl = `https://github.com/pwrdrvr/PwrGit/releases/download/${value.tag_name}/PwrGit-windows-SHA256SUMS`;
  const sums = `${value.assets[2].digest.slice(7)}  ${value.assets[2].name}`;
  value.assets.push({ name: "PwrGit-windows-SHA256SUMS", browser_download_url: sumsUrl,
    digest: `sha256:${createHash("sha256").update(sums).digest("hex")}`, size: Buffer.byteLength(sums) });
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
    if (url === sumsUrl) return new Response(sums);
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
    expect(readdirSync(join(directory, "downloads"))).toHaveLength(4);
    const previousRequests = requests.length;
    await prepare(value.tag_name, directory, { api: releaseApi, fetch: fetchAsset });
    expect(requests.slice(previousRequests)).toEqual([]);
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


test("requires remote manifest URLs and hashes to match published release metadata", async () => {
  const source = api({ winget: ["0.27.0"], cask: "0.27.0" });
  await expect(audit({ api: (path, options) => {
    const result = source(path, options);
    if (path.includes(".installer.yaml")) result.content = Buffer.from(Buffer.from(result.content, "base64").toString().replace("3".repeat(64), "4".repeat(64))).toString("base64");
    return result;
  } })).rejects.toThrow("URL/checksum disagrees");
});

test("recognizes established architectures and rejects changed remote layouts", () => {
  const files = renderManifests(release(), selectAssets(release()));
  expect(readCask(files["Casks/pwrgit.rb"]).assets.map((a) => a.architecture)).toEqual(["arm64", "universal"]);
  const installer = files[`${distribution.wingetPath}/0.27.0/${distribution.wingetId}.installer.yaml`];
  expect(readWingetInstaller(installer, "0.27.0")[0].architecture).toBe("x64");
  expect(() => readWingetInstaller(installer.replace("Architecture: x64", "Architecture: arm64"), "0.27.0")).toThrow("layout changed");
  expect(() => readCask(files["Casks/pwrgit.rb"].replace('intel: "universal"', 'intel: "x64"'))).toThrow("layout changed");
});

test("retains closed submission history and confirms public repository reads", async () => {
  const source = api({ pending: [{ html_url: "https://github.com/example/pull/3", state: "closed", user: { login: "huntharo" } }] });
  const result = await audit({ api: source });
  expect(result.submissions.winget[0]).toMatchObject({ state: "closed", author: "huntharo" });
  await expect(audit({ api: (path) => /^repos\/[^/]+\/[^/?]+$/.test(path) ? { private: true } : source(path) })).rejects.toThrow("readable/public");
});

// Every substituted URL and digest below belongs to a real published asset in
// the fixture. Only the platform/architecture is wrong, so membership checks
// alone would accept it. Exercise current and lagging package versions.
test.each([
  ["winget", 0], ["winget", 1],
  ["homebrew", 0], ["homebrew", 1], ["homebrew", 2],
].flatMap(([channel, wrongAsset]) => ["0.27.0", "0.28.0"].map((latest) => ({ channel, wrongAsset, latest }))))(
  "blocks $channel using asset $wrongAsset against Latest $latest",
  async ({ channel, wrongAsset, latest }) => {
    const source = api({ winget: ["0.27.0"], cask: "0.27.0" });
    const published = release().assets[wrongAsset];
    await expect(audit({ api: (path, options) => {
      if (path.endsWith("/releases/latest")) return release(latest);
      const result = source(path, options);
      if (channel === "winget" && path.includes(".installer.yaml")) {
        const text = Buffer.from(result.content, "base64").toString("utf8")
          .replace(/^  InstallerUrl:.*$/m, `  InstallerUrl: ${published.browser_download_url}`)
          .replace(/^  InstallerSha256:.*$/m, `  InstallerSha256: ${published.digest.slice(7)}`);
        result.content = Buffer.from(text).toString("base64");
      }
      if (channel === "homebrew" && path.includes("homebrew-tap/contents")) {
        const text = Buffer.from(result.content, "base64").toString("utf8")
          .replace(/^  url .*$/m, `  url "${published.browser_download_url}"`)
          .replace(/^  sha256 arm:.*$/m, `  sha256 arm:   "${published.digest.slice(7)}",`)
          .replace(/^ +intel: "[a-f0-9]{64}"$/m, `         intel: "${published.digest.slice(7)}"`);
        result.content = Buffer.from(text).toString("base64");
      }
      return result;
    } })).rejects.toThrow("URL/checksum disagrees");
  },
);

function downloadableRelease() {
  const value = release();
  const payloads = value.assets.map((asset) => Buffer.from(`verified ${asset.name}`));
  const sums = Buffer.from(`${createHash("sha256").update(payloads[2]).digest("hex")}  ${value.assets[2].name}\n`);
  value.assets.push({ name: "PwrGit-windows-SHA256SUMS", browser_download_url: `https://github.com/pwrdrvr/PwrGit/releases/download/${value.tag_name}/PwrGit-windows-SHA256SUMS` });
  payloads.push(sums);
  value.assets.forEach((asset, i) => {
    asset.size = payloads[i].length;
    asset.digest = `sha256:${createHash("sha256").update(payloads[i]).digest("hex")}`;
  });
  return { value, payloads };
}

test("daily plan generates metadata without fetching any release bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-distribution-plan-"));
  const { value } = downloadableRelease();
  const source = api({ cask: "0.27.0" });
  try {
    await prepare(value.tag_name, directory, {
      api: (path) => {
        if (path.includes("/releases/")) return value;
        if (path.includes("homebrew-tap/contents")) return { encoding: "base64", content: Buffer.from(renderManifests(value, selectAssets(value))["Casks/pwrgit.rb"]).toString("base64") };
        return source(path);
      },
      fetch: () => { throw new Error("No asset downloads allowed"); }, metadataOnly: true, validatorDigest: "a".repeat(64),
    });
    expect(readdirSync(directory).sort()).toEqual(["Casks", "distribution-status.json", "manifests"]);
    const status = JSON.parse(readFileSync(join(directory, "distribution-status.json")));
    expect(status.assets).toHaveLength(3);
    expect(status.winget.version).toBeNull();
    expect(status.validation.windows_cache).toContain("0.27.0-windows-x64-");
    expect(publicationFailures(status)).toEqual(["winget: registration absent; expected 0.27.0; no open submission found"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("validation identity ignores routine metadata but changes for relevant inputs", () => {
  const { value } = downloadableRelease();
  const report = { winget: { version: null }, checkedAt: "yesterday", homebrew: { version: null } };
  const digest = "a".repeat(64);
  const plan = validationPlan(value, report, digest);
  const changedCounters = structuredClone(value);
  changedCounters.assets.forEach((asset) => { asset.download_count = 99; });
  expect(validationPlan(changedCounters, { ...report, checkedAt: "today", homebrew: { version: "0.27.0" } }, digest)).toEqual(plan);
  const changedBytes = structuredClone(value);
  changedBytes.assets[0].digest = `sha256:${"f".repeat(64)}`;
  const bytesPlan = validationPlan(changedBytes, report, digest);
  expect(bytesPlan.macos_validation).not.toBe(plan.macos_validation);
  expect(bytesPlan.arm64_cache).not.toBe(plan.arm64_cache);
  expect(bytesPlan.windows_validation).toBe(plan.windows_validation);
  const windowsBytes = structuredClone(value);
  windowsBytes.assets[2].digest = `sha256:${"f".repeat(64)}`;
  expect(validationPlan(windowsBytes, report, digest).windows_validation).not.toBe(plan.windows_validation);
  const newRelease = structuredClone(value);
  newRelease.tag_name = "v0.28.0";
  newRelease.assets.forEach((asset) => {
    asset.name = asset.name.replace("0.27.0", "0.28.0");
    asset.browser_download_url = asset.browser_download_url.replaceAll("0.27.0", "0.28.0");
  });
  const versionPlan = validationPlan(newRelease, report, digest);
  expect(versionPlan.macos_validation).not.toBe(plan.macos_validation);
  expect(versionPlan.windows_validation).not.toBe(plan.windows_validation);
  expect(versionPlan.windows_cache).not.toBe(plan.windows_cache);
  const logicPlan = validationPlan(value, report, "b".repeat(64));
  expect(logicPlan.macos_validation).not.toBe(plan.macos_validation);
  expect(logicPlan.windows_validation).not.toBe(plan.windows_validation);
  expect(logicPlan.windows_cache).toBe(plan.windows_cache);
  const windowsLogicPlan = validationPlan(value, report, digest, "b".repeat(64));
  expect(windowsLogicPlan.macos_validation).toBe(plan.macos_validation);
  expect(windowsLogicPlan.windows_validation).not.toBe(plan.windows_validation);
  const upgradePlan = validationPlan(value, { ...report, winget: { version: "0.26.0" } }, digest);
  expect(upgradePlan.windows_validation).not.toBe(plan.windows_validation);
  expect(upgradePlan.macos_validation).toBe(plan.macos_validation);
  const changedSums = structuredClone(value);
  changedSums.assets[3].digest = `sha256:${"f".repeat(64)}`;
  expect(validationPlan(changedSums, report, digest).windows_validation).not.toBe(plan.windows_validation);
  expect(() => validationPlan(value, report, "")).toThrow("validator inputs");
});

test("platform downloads fetch once and verify restored bytes before reuse", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-distribution-cache-"));
  const { value, payloads } = downloadableRelease();
  const source = api();
  const requests = [];
  const fetchAsset = async (url) => {
    requests.push(url);
    return new Response(payloads[value.assets.findIndex((asset) => asset.browser_download_url === url)]);
  };
  try {
    await prepare(value.tag_name, directory, { api: (path) => path.includes("/releases/") ? value : source(path), metadataOnly: true });
    await downloadPlatform(directory, "windows", { fetch: fetchAsset });
    expect(requests).toEqual(value.assets.slice(2).map((asset) => asset.browser_download_url));
    await downloadPlatform(directory, "windows", { fetch: () => { throw new Error("cache hit must not fetch"); } });
    await downloadPlatform(directory, "macos", { fetch: fetchAsset });
    expect(requests).toHaveLength(4);
    await downloadPlatform(directory, "all", { fetch: () => { throw new Error("cache hit must not fetch"); } });
    writeFileSync(join(directory, "downloads", value.assets[2].name), "corrupt restore");
    await expect(downloadPlatform(directory, "windows", { fetch: fetchAsset })).rejects.toThrow("bytes do not match GitHub");
    expect(requests).toHaveLength(4);
    writeFileSync(join(directory, "downloads", value.assets[2].name), payloads[2]);
    writeFileSync(join(directory, "downloads", value.assets[3].name), "corrupt checksum restore");
    await expect(downloadPlatform(directory, "windows", { fetch: fetchAsset })).rejects.toThrow("bytes do not match GitHub");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an absent channel and a pending submission remain publication failures", async () => {
  const report = await audit({ api: api({ winget: ["0.26.0"], cask: "0.27.0", pending: [{ html_url: "https://github.com/example/pull/1", title: "PwrGit", state: "open" }] }) });
  expect(publicationFailures(report)).toEqual(["winget: published 0.26.0; expected 0.27.0; open submissions: https://github.com/example/pull/1"]);
});

test("closed submission history is retained without becoming an open publication blocker", async () => {
  const report = await audit({ api: api({ cask: "0.27.0", pending: [{ html_url: "https://github.com/example/pull/2", state: "closed" }] }) });
  expect(report.submissions.winget).toHaveLength(1);
  expect(publicationFailures(report)).toEqual(["winget: registration absent; expected 0.27.0; no open submission found"]);
});

test("rejects an authenticated checksum file that disagrees with the installer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-distribution-sums-"));
  const { value, payloads } = downloadableRelease();
  payloads[3] = Buffer.from(`${"0".repeat(64)}  ${value.assets[2].name}\n`);
  value.assets[3].digest = `sha256:${createHash("sha256").update(payloads[3]).digest("hex")}`;
  const source = api();
  try {
    await prepare(value.tag_name, directory, { api: (path) => path.includes("/releases/") ? value : source(path), metadataOnly: true });
    await expect(downloadPlatform(directory, "windows", { fetch: async (url) => new Response(payloads[value.assets.findIndex((asset) => asset.browser_download_url === url)]) })).rejects.toThrow("checksum file disagrees");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
