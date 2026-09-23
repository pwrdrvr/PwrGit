#!/usr/bin/env node
// Publish only after every signed asset is present and verified on a draft.
// A failed upload may have reached GitHub before its response was lost, so
// reconcile the remote digest rather than blindly retrying or clobbering it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repo = "pwrdrvr/PwrGit";

export function expectedAssetNames(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  const version = tag.slice(1);
  return [
    `PwrGit-${version}-arm64-mac.zip`,
    `PwrGit-${version}-arm64-mac.zip.blockmap`,
    `PwrGit-${version}-arm64.dmg`,
    `PwrGit-${version}-universal-mac.zip`,
    `PwrGit-${version}-universal-mac.zip.blockmap`,
    `PwrGit-${version}-universal.dmg`,
    "PwrGit-arm64.dmg",
    "PwrGit.dmg",
    "latest-mac.yml",
    `PwrGit-${version}-windows-x64-setup.exe`,
    `PwrGit-${version}-windows-x64-setup.exe.blockmap`,
    "PwrGit.Setup.exe",
    "PwrGit-windows-SHA256SUMS",
    "latest.yml",
  ].sort();
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    if (!entry.isFile()) throw new Error(`Release input is not a regular file: ${path}`);
    return [path];
  });
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export async function collectAssets(tag, macDir, windowsDir) {
  const paths = [...filesUnder(macDir), ...filesUnder(windowsDir)];
  const byName = new Map();
  for (const path of paths) {
    const name = basename(path);
    if (byName.has(name)) throw new Error(`Duplicate release asset basename: ${name}`);
    const size = statSync(path).size;
    if (size === 0) throw new Error(`Empty release asset: ${path}`);
    byName.set(name, { name, path, size, digest: await digest(path) });
  }
  const expected = expectedAssetNames(tag);
  const actual = [...byName.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Release inventory mismatch. Expected ${expected.join(", ")}; got ${actual.join(", ")}`);
  }
  const version = tag.slice(1);
  for (const [alias, original] of [
    ["PwrGit.dmg", `PwrGit-${version}-universal.dmg`],
    ["PwrGit-arm64.dmg", `PwrGit-${version}-arm64.dmg`],
    ["PwrGit.Setup.exe", `PwrGit-${version}-windows-x64-setup.exe`],
  ]) {
    if (byName.get(alias).digest !== byName.get(original).digest) {
      throw new Error(`${alias} differs from ${original}`);
    }
  }
  return expected.map((name) => byName.get(name));
}

function realGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function getRelease(tag, gh) {
  // The by-tag endpoint does not resolve drafts; the releases list does.
  const pages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]));
  return pages.flat().find((release) => release.tag_name === tag);
}

function assertMetadata(release, tag, notes) {
  if (release.tag_name !== tag || release.name !== tag || release.body.trim() !== notes.trim() || !release.prerelease) {
    throw new Error(`Release ${tag} metadata differs from the checked changelog notes or Pre-release flag`);
  }
}

function checkRemoteAssets(release, assets, allowMissing) {
  const expected = new Map(assets.map((asset) => [asset.name, asset]));
  const seen = new Set();
  for (const remote of release.assets) {
    const local = expected.get(remote.name);
    if (!local || seen.has(remote.name)) throw new Error(`Unexpected or duplicate remote release asset: ${remote.name}`);
    seen.add(remote.name);
    if (remote.state !== "uploaded" || remote.size !== local.size || remote.digest !== local.digest) {
      throw new Error(`Remote release asset differs from signed input: ${remote.name}`);
    }
  }
  if (!allowMissing && seen.size !== assets.length) {
    throw new Error(`Release is missing assets: ${assets.filter((asset) => !seen.has(asset.name)).map((asset) => asset.name).join(", ")}`);
  }
  return seen;
}

export async function publishRelease({ tag, macDir, windowsDir, notesFile, gh = realGh }) {
  // Finish all local checks before the first remote mutation.
  const assets = await collectAssets(tag, macDir, windowsDir);
  const notes = readFileSync(notesFile, "utf8");
  if (!notes.trim()) throw new Error("Release notes are empty");
  let release = getRelease(tag, gh);
  if (!release) {
    try {
      gh(["release", "create", tag, "--repo", repo, "--verify-tag", "--title", tag,
        "--notes-file", notesFile, "--prerelease", "--latest=false", "--draft"]);
    } catch (error) {
      // A lost create response or another queued run can still leave a draft.
      release = getRelease(tag, gh);
      if (!release) throw error;
    }
    release = getRelease(tag, gh);
    if (!release) throw new Error(`Created release ${tag} is not visible`);
  }
  assertMetadata(release, tag, notes);
  let present = checkRemoteAssets(release, assets, release.draft);
  if (!release.draft) {
    console.log(`Release ${tag} is already complete`);
    return;
  }

  for (const asset of assets) {
    if (present.has(asset.name)) continue;
    try {
      gh(["release", "upload", tag, asset.path, "--repo", repo]);
    } catch (error) {
      release = getRelease(tag, gh);
      if (!release) throw error;
      assertMetadata(release, tag, notes);
      present = checkRemoteAssets(release, assets, true);
      if (!present.has(asset.name)) throw error;
      console.log(`Upload response failed, but ${asset.name} is present with the expected digest`);
      continue;
    }
    release = getRelease(tag, gh);
    assertMetadata(release, tag, notes);
    present = checkRemoteAssets(release, assets, true);
    if (!present.has(asset.name)) throw new Error(`Upload returned success but ${asset.name} is missing`);
  }

  release = getRelease(tag, gh);
  assertMetadata(release, tag, notes);
  checkRemoteAssets(release, assets, false);
  if (!release.draft) throw new Error(`Release ${tag} was published before asset validation`);
  gh(["release", "edit", tag, "--repo", repo, "--draft=false", "--prerelease", "--latest=false"]);
  release = getRelease(tag, gh);
  if (!release || release.draft) throw new Error(`Release ${tag} was not published`);
  assertMetadata(release, tag, notes);
  checkRemoteAssets(release, assets, false);
  console.log(`Published ${tag} with ${assets.length} verified assets`);
}

async function runCli() {
  const [tag, macDir, windowsDir, notesFile] = process.argv.slice(2);
  if (!tag || !macDir || !windowsDir || !notesFile) {
    throw new Error("Usage: publish-desktop-release.mjs <tag> <mac-dir> <windows-dir> <notes-file>");
  }
  await publishRelease({ tag, macDir, windowsDir, notesFile });
}

if (isCliEntrypoint(import.meta.url)) {
  runCli().catch((error) => { console.error(error); process.exitCode = 1; });
}
