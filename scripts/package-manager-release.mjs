#!/usr/bin/env node
// Package managers follow the promoted Stable Latest release, never a build tag.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createWriteStream } from "node:fs";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

export const distribution = {
  repo: "pwrdrvr/PwrGit",
  wingetRepo: "microsoft/winget-pkgs",
  wingetId: "PwrDrvr.PwrGit",
  wingetPath: "manifests/p/PwrDrvr/PwrGit",
  tapRepo: "pwrdrvr/homebrew-tap",
  cask: "pwrdrvr/tap/pwrgit",
};

async function ghJson(endpoint, optional = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      const message = String(error.stderr);
      // Authentication, throttling and transport errors are never package absence.
      if (optional && message.includes("(HTTP 404)")) return null;
      const seconds = Number(message.match(/try again in ([\d.]+)s/)?.[1]);
      if (attempt === 0 && message.includes("(HTTP 429)") && seconds > 0 && seconds <= 900) {
        console.error(`GitHub throttled ${endpoint}; retrying once after ${Math.ceil(seconds) + 1}s`);
        await sleep((Math.ceil(seconds) + 1) * 1000);
        continue;
      }
      throw error;
    }
  }
}

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

export async function audit({ api = ghJson } = {}) {
  const release = await api(`repos/${distribution.repo}/releases/latest`);
  const version = stableVersion(release);
  const winget = await api(`repos/${distribution.wingetRepo}/contents/${distribution.wingetPath}`, true);
  const tap = await api(`repos/${distribution.tapRepo}/contents/Casks/pwrgit.rb`, true);
  const central = await api("repos/Homebrew/homebrew-cask/contents/Casks/p/pwrgit.rb", true);
  const duplicates = await api("search/code?q=pwrgit+repo:microsoft/winget-pkgs");
  if (duplicates.incomplete_results) throw new Error("Winget identity search was incomplete");
  if (duplicates.items.some((item) => !item.path.startsWith(`${distribution.wingetPath}/`))) {
    throw new Error("Another Winget identity mentions PwrGit; resolve ownership before submitting");
  }
  if (central) throw new Error("Homebrew core now contains pwrgit; reconcile distribution ownership before proceeding");
  const wingetVersions = (winget ?? []).map((entry) => entry.name);
  if (wingetVersions.some((v) => !/^\d+\.\d+\.\d+$/.test(v))) {
    throw new Error("Unexpected Winget version; compare the remote manifests manually");
  }
  const wingetVersion = wingetVersions.sort(compareVersions).at(-1) ?? null;
  const caskText = tap ? Buffer.from(tap.content, "base64").toString("utf8") : "";
  const caskVersion = tap ? caskText.match(/^  version "(\d+\.\d+\.\d+)"$/m)?.[1] : null;
  if (tap && !caskVersion) throw new Error("Cannot read the authoritative cask version");
  for (const current of [wingetVersion, caskVersion]) {
    if (current && compareVersions(current, version) > 0) throw new Error("Remote package is newer than Latest; refusing a downgrade");
  }
  const submissions = {};
  for (const [channel, repo] of [["winget", distribution.wingetRepo], ["homebrew", distribution.tapRepo]]) {
    const result = await api(`search/issues?q=${encodeURIComponent(`pwrgit repo:${repo} is:pr is:open`)}`);
    if (result.incomplete_results) throw new Error("Submission search was incomplete");
    submissions[channel] = result.items.map(({ html_url, title }) => ({ url: html_url, title }));
  }
  return {
    checkedAt: new Date().toISOString(), stableTag: release.tag_name, version,
    winget: { identifier: distribution.wingetId, source: `https://github.com/${distribution.wingetRepo}/tree/master/${distribution.wingetPath}`, version: wingetVersion },
    homebrew: { identifier: distribution.cask, source: `https://github.com/${distribution.tapRepo}/blob/main/Casks/pwrgit.rb`, version: caskVersion },
    submissions,
    // Repository presence does not prove Winget index propagation or brew cache refresh.
    clientPublication: "Verify with winget source update/show and brew update/info on fresh clients",
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

export async function prepare(tag, directory, { api = ghJson } = {}) {
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
      const response = await fetch(asset.browser_download_url);
      if (!response.ok || !response.body) throw new Error(`Download failed: ${asset.name} HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
    }
    const actual = await hashFile(path);
    if (actual.digest !== asset.digest || actual.size !== asset.size) throw new Error(`Downloaded bytes do not match GitHub: ${asset.name}`);
    inventory.push({ name: asset.name, url: asset.browser_download_url, ...actual });
  }
  const sumsAsset = release.assets.find((asset) => asset.name === "PwrGit-windows-SHA256SUMS");
  if (!sumsAsset) throw new Error("Missing Windows release checksum file");
  const sumsResponse = await fetch(sumsAsset.browser_download_url);
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
    const report = await audit();
    console.log(JSON.stringify(report, null, 2));
    if (tag === "--check" && [report.winget.version, report.homebrew.version].some((v) => v !== report.version)) {
      throw new Error("Package sources lag Stable Latest; follow pending submissions before opening another PR");
    }
  } else if (command === "prepare" && directory) {
    console.log(JSON.stringify(await prepare(tag, directory), null, 2));
  } else {
    throw new Error("Usage: package-manager-release.mjs audit [--check] | prepare vX.Y.Z <output-directory>");
  }
}

if (isCliEntrypoint(import.meta.url)) runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
