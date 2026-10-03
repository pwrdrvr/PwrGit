#!/usr/bin/env node
// Package managers follow the promoted Stable Latest release, never a build tag.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { makeApi, searchAll } from "./lib/distribution-api.mjs";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

export const distribution = {
  repo: "pwrdrvr/PwrGit",
  wingetRepo: "microsoft/winget-pkgs",
  wingetId: "PwrDrvr.PwrGit",
  wingetPath: "manifests/p/PwrDrvr/PwrGit",
  tapRepo: "pwrdrvr/homebrew-tap",
  cask: "pwrdrvr/tap/pwrgit",
};

const ghJson = makeApi();

export function stableVersion(release) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error("Package managers require a published, promoted, suffix-free Stable Latest release");
  }
  return release.tag_name.slice(1);
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const delta = Number(a.split(".")[i]) - Number(b.split(".")[i]);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

function sourceText(file) {
  if (file?.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error("Audit blocked: missing authoritative source content");
  }
  return Buffer.from(file.content, "base64").toString("utf8").replaceAll("\r\n", "\n");
}

// Deliberately recognize the established manifest/cask layout; a changed layout
// requires inspection rather than an invented architecture or checksum.
export function readWingetInstaller(text, version) {
  if (!new RegExp(`^PackageIdentifier: ${distribution.wingetId.replaceAll(".", "\\.")}$`, "m").test(text) ||
      text.match(/^PackageVersion: (\d+\.\d+\.\d+)$/m)?.[1] !== version) throw new Error("Audit blocked: Winget identity/version changed");
  const architectures = [...text.matchAll(/^\s*-?\s*Architecture:\s*(\S+)/gm)].map((m) => m[1]);
  const urls = [...text.matchAll(/^\s*InstallerUrl:\s*(\S+)/gm)].map((m) => m[1]);
  const hashes = [...text.matchAll(/^\s*InstallerSha256:\s*([a-fA-F0-9]{64})\s*$/gm)].map((m) => m[1].toLowerCase());
  if (architectures.length !== 1 || architectures[0] !== "x64" || urls.length !== 1 || hashes.length !== 1) {
    throw new Error("Audit blocked: Winget installer layout changed; inspect architectures/URLs/checksums");
  }
  return [{ architecture: "x64", url: urls[0], digest: `sha256:${hashes[0]}` }];
}

export function readCask(text) {
  const version = text.match(/^  version "(\d+\.\d+\.\d+)"$/m)?.[1];
  const url = text.match(/^  url "([^"\n]+)"$/m)?.[1];
  const arm = text.match(/^  sha256 arm: +"([a-f0-9]{64})",$/m)?.[1];
  const intel = text.match(/^ +intel: "([a-f0-9]{64})"$/m)?.[1];
  if (!text.startsWith('cask "pwrgit" do\n') || !text.includes('  app "PwrGit.app"\n') || !version || !url || !arm || !intel || !text.includes('arch arm: "arm64", intel: "universal"')) {
    throw new Error("Audit blocked: cask layout changed; inspect version/architectures/URLs/checksums");
  }
  const assets = [["arm64", arm], ["universal", intel]].map(([architecture, hash]) => ({
    architecture, url: url.replaceAll("#{version}", version).replaceAll("#{arch}", architecture), digest: `sha256:${hash}`,
  }));
  return { version, assets };
}

export async function audit({ api = ghJson } = {}) {
  const repositories = {};
  for (const repo of [distribution.repo, distribution.wingetRepo, distribution.tapRepo, "Homebrew/homebrew-cask", "Homebrew/homebrew-core"]) {
    const metadata = await api(`repos/${repo}`);
    if (metadata.private !== false || !metadata.default_branch) throw new Error(`Audit blocked: ${repo} is not confirmed readable/public`);
    repositories[repo] = metadata.default_branch;
  }
  const release = await api(`repos/${distribution.repo}/releases/latest`);
  const version = stableVersion(release);
  const targetAssets = selectAssets(release);
  const wingetRef = repositories[distribution.wingetRepo];
  const tapRef = repositories[distribution.tapRepo];
  const winget = await api(`repos/${distribution.wingetRepo}/contents/${distribution.wingetPath}?ref=${wingetRef}`, { allow404: true });
  const tap = await api(`repos/${distribution.tapRepo}/contents/Casks/pwrgit.rb?ref=${tapRef}`, { allow404: true });
  const identities = await searchAll(api, "code", "pwrgit repo:microsoft/winget-pkgs");
  if (identities.some((item) => !item.path?.startsWith(`${distribution.wingetPath}/`)) || (!winget && identities.length)) {
    throw new Error("Audit blocked: Another Winget identity mentions PwrGit or known path disagrees with search; resolve ownership before submitting");
  }
  // Discover central casks AND formulae, including alternate names/paths.
  for (const repo of ["Homebrew/homebrew-cask", "Homebrew/homebrew-core"]) {
    const matches = await searchAll(api, "code", `pwrgit repo:${repo}`);
    if (matches.length) throw new Error(`Audit blocked: ${repo} mentions PwrGit; reconcile distribution ownership before proceeding`);
  }
  if (winget !== null && !Array.isArray(winget)) throw new Error("Audit blocked: malformed Winget directory");
  const wingetVersions = (winget ?? []).map((entry) => entry.name);
  if (wingetVersions.some((v) => !/^\d+\.\d+\.\d+$/.test(v)) || (winget && !wingetVersions.length)) {
    throw new Error("Audit blocked: Unexpected Winget version; compare the remote manifests manually");
  }
  const wingetVersion = wingetVersions.sort(compareVersions).at(-1) ?? null;
  const cask = tap ? readCask(sourceText(tap)) : { version: null, assets: [] };
  for (const current of [wingetVersion, cask.version]) {
    if (current && compareVersions(current, version) > 0) throw new Error("Remote package is newer than Latest; refusing a downgrade");
  }
  const wingetInstallerPath = wingetVersion && `${distribution.wingetPath}/${wingetVersion}/${distribution.wingetId}.installer.yaml`;
  const wingetAssets = wingetInstallerPath ? readWingetInstaller(sourceText(await api(`repos/${distribution.wingetRepo}/contents/${wingetInstallerPath}?ref=${wingetRef}`)), wingetVersion) : [];
  // Compare authoritative manifest URLs/checksums to their published GitHub
  // release, including lagging versions; prepare() separately hashes real bytes.
  for (const [channel, current, assets] of [["winget", wingetVersion, wingetAssets], ["homebrew", cask.version, cask.assets]]) {
    if (!current) continue;
    const published = current === version ? targetAssets : selectAssets(await api(`repos/${distribution.repo}/releases/tags/v${current}`));
    const [arm64, universal, windowsX64] = published;
    const expectedAssets = channel === "winget" ? { x64: windowsX64 } : { arm64, universal };
    for (const asset of assets) {
      const expected = expectedAssets[asset.architecture];
      if (!expected || expected.browser_download_url !== asset.url || expected.digest !== asset.digest) {
        throw new Error(`Audit blocked: remote package URL/checksum disagrees with published GitHub assets for ${channel} ${asset.architecture}`);
      }
    }
  }
  const submissions = {};
  for (const [channel, repo] of [["winget", distribution.wingetRepo], ["homebrew", distribution.tapRepo]]) {
    const results = await searchAll(api, "issues", `pwrgit repo:${repo} is:pr`);
    submissions[channel] = results.map(({ html_url, title, state, user }) => ({ url: html_url, title, state, author: user?.login }));
  }
  const channelState = (current, channel) => current === version ? "source-current; client verification pending" :
    submissions[channel].some((p) => p.state === "open") ? "pending-review; inspect existing submission before updating" :
      current ? "source-lagging; maintainer update required" : "not-published-at-known-path; maintainer submission required";
  return {
    status: "complete", checkedAt: new Date().toISOString(), stableTag: release.tag_name, version,
    github: { url: release.html_url, policy: "promoted suffix-free Stable Latest; prereleases leave package channels unchanged", assets: targetAssets.map(({ name, browser_download_url, digest, size }) => ({ name, url: browser_download_url, digest, size })) },
    repositories,
    winget: { identifier: distribution.wingetId, source: `https://github.com/${distribution.wingetRepo}/tree/${wingetRef}/${distribution.wingetPath}`, version: wingetVersion, assets: wingetAssets, installerSource: wingetInstallerPath && `https://github.com/${distribution.wingetRepo}/blob/${wingetRef}/${wingetInstallerPath}`, owner: "huntharo (submission); Microsoft (review/index)", state: channelState(wingetVersion, "winget") },
    homebrew: { identifier: distribution.cask, source: `https://github.com/${distribution.tapRepo}/blob/${tapRef}/Casks/pwrgit.rb`, version: cask.version, assets: cask.assets, owner: "huntharo / PwrDrvr tap maintainers", state: channelState(cask.version, "homebrew") },
    submissions,
    clientPublication: "Verify with winget source update/show and brew update/info on fresh disposable clients; repository presence does not prove index/cache/install/upgrade",
  };
}

export function selectAssets(release) {
  const version = stableVersion(release);
  return ["arm64.dmg", "universal.dmg", "windows-x64-setup.exe"].map((suffix) => {
    const name = `PwrGit-${version}-${suffix}`;
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) throw new Error(`Expected one signed versioned asset: ${name}`);
    const asset = matches[0];
    const url = `https://github.com/${distribution.repo}/releases/download/${release.tag_name}/${name}`;
    if (asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") || asset.size <= 0) {
      throw new Error(`Invalid URL, size or GitHub digest: ${name}`);
    }
    return asset;
  });
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; }
  return { digest: `sha256:${hash.digest("hex")}`, size };
}

export function renderManifests(release, assets) {
  const version = stableVersion(release);
  const [arm, intel, windows] = assets;
  const sha = (asset) => asset.digest.slice(7);
  const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.12.0.schema.json\n\nPackageIdentifier: ${distribution.wingetId}\nPackageVersion: ${version}\n`;
  return {
    "Casks/pwrgit.rb": `cask "pwrgit" do
  arch arm: "arm64", intel: "universal"

  version "${version}"
  sha256 arm:   "${sha(arm)}",
         intel: "${sha(intel)}"

  url "https://github.com/pwrdrvr/PwrGit/releases/download/v#{version}/PwrGit-#{version}-#{arch}.dmg"
  name "PwrGit"
  desc "Desktop Git client for managing repositories and worktrees"
  homepage "https://pwrgit.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "PwrGit.app"
end
`,
    [`${distribution.wingetPath}/${version}/${distribution.wingetId}.yaml`]: `${header("version")}DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.12.0\n`,
    [`${distribution.wingetPath}/${version}/${distribution.wingetId}.locale.en-US.yaml`]: `${header("defaultLocale")}PackageLocale: en-US
Publisher: PwrDrvr LLC
PublisherUrl: https://pwrdrvr.com/
PublisherSupportUrl: https://github.com/pwrdrvr/PwrGit/issues
PackageName: PwrGit
PackageUrl: https://pwrgit.com/
License: MIT
LicenseUrl: https://github.com/pwrdrvr/PwrGit/blob/${release.tag_name}/LICENSE
ShortDescription: Desktop Git client for managing repositories and worktrees
ReleaseNotesUrl: https://github.com/pwrdrvr/PwrGit/releases/tag/${release.tag_name}
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`,
    [`${distribution.wingetPath}/${version}/${distribution.wingetId}.installer.yaml`]: `${header("installer")}InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
InstallerSwitches:
  Custom: /currentuser
UpgradeBehavior: install
AppsAndFeaturesEntries:
- DisplayName: PwrGit
  Publisher: PwrDrvr LLC
Installers:
- Architecture: x64
  InstallerUrl: ${windows.browser_download_url}
  InstallerSha256: ${sha(windows).toUpperCase()}
ManifestType: installer
ManifestVersion: 1.12.0
`,
  };
}

export async function prepare(tag, directory, { api = ghJson, fetch: fetchAsset = fetch } = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Usage: prepare vX.Y.Z <output-directory>");
  const report = await audit({ api });
  if (tag !== report.stableTag) throw new Error(`Only Stable Latest ${report.stableTag} can update the package managers`);
  const release = await api(`repos/${distribution.repo}/releases/tags/${tag}`);
  const assets = selectAssets(release);
  const downloads = join(directory, "downloads");
  mkdirSync(downloads, { recursive: true });
  const inventory = [];
  for (const asset of assets) {
    const path = join(downloads, asset.name);
    if (!existsSync(path)) {
      const response = await fetchAsset(asset.browser_download_url);
      if (!response.ok || !response.body) throw new Error(`Download failed: ${asset.name} HTTP ${response.status}`);
      const temporaryDirectory = mkdtempSync(join(downloads, ".download-"));
      const temporaryPath = join(temporaryDirectory, asset.name);
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
        const actual = await hashFile(temporaryPath);
        if (actual.digest !== asset.digest || actual.size !== asset.size) throw new Error(`Downloaded bytes do not match GitHub: ${asset.name}`);
        renameSync(temporaryPath, path);
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
    const actual = await hashFile(path);
    if (actual.digest !== asset.digest || actual.size !== asset.size) throw new Error(`Downloaded bytes do not match GitHub: ${asset.name}`);
    inventory.push({ name: asset.name, url: asset.browser_download_url, ...actual });
  }
  const sumsAsset = release.assets.find((asset) => asset.name === "PwrGit-windows-SHA256SUMS");
  if (!sumsAsset) throw new Error("Missing Windows release checksum file");
  const sumsResponse = await fetchAsset(sumsAsset.browser_download_url);
  if (!sumsResponse.ok) throw new Error("Windows checksum download failed");
  const sums = await sumsResponse.text();
  const expected = `${assets[2].digest.slice(7)}  ${assets[2].name}`;
  if (sums.trim() !== expected) throw new Error("Windows checksum file disagrees with the downloaded signed installer");
  for (const [name, content] of Object.entries(renderManifests(release, assets))) {
    const path = join(directory, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  writeFileSync(join(directory, "distribution-status.json"), `${JSON.stringify({ ...report, assets: inventory }, null, 2)}\n`);
  return report;
}

export async function runCli(args = process.argv.slice(2)) {
  const [command, tag, directory] = args;
  if (command === "audit") {
    const outputIndex = args.indexOf("--output");
    const output = outputIndex < 0 ? null : args[outputIndex + 1];
    if (outputIndex >= 0 && !output) throw new Error("--output requires a path");
    let report;
    try {
      report = await audit();
      if (args.includes("--check") && [report.winget.version, report.homebrew.version].some((v) => v !== report.version)) {
        report.check = "blocked: package sources lag Stable Latest; huntharo must follow existing submissions before opening another PR";
        process.exitCode = 1;
      }
    } catch (error) {
      report = { status: "blocked", checkedAt: new Date().toISOString(), error: error.message, owner: "huntharo / PwrDrvr organization maintainers", nextAction: "Resolve remote read/search/source blocker and rerun; do not infer absence or submit duplicates" };
      process.exitCode = 1;
    }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output) { mkdirSync(join(output, ".."), { recursive: true }); writeFileSync(output, json); }
    console.log(json);
  } else if (command === "prepare" && directory) {
    console.log(JSON.stringify(await prepare(tag, directory), null, 2));
  } else {
    throw new Error("Usage: package-manager-release.mjs audit [--check] [--output <path>] | prepare vX.Y.Z <output-directory>");
  }
}

if (isCliEntrypoint(import.meta.url)) runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
