#!/usr/bin/env node
// Release metadata gate, ported from PwrSnap. Verifies that a release tag,
// apps/desktop/package.json, electron-builder.yml, and CHANGELOG.md all agree
// before any signing/publishing work starts, and can extract the changelog
// section as release notes for `gh release edit`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackagePath = resolve(repoRoot, "apps/desktop/package.json");
const electronBuilderPath = resolve(repoRoot, "apps/desktop/electron-builder.yml");
const releaseWorkflowPath = resolve(repoRoot, ".github/workflows/release.yml");
const workflowsReadmePath = resolve(repoRoot, ".github/workflows/README.md");
const releaseScriptPath = resolve(repoRoot, "apps/desktop/scripts/release.mjs");
const verifyAsarContentsPath = resolve(
  repoRoot,
  "apps/desktop/scripts/verify-asar-contents.mjs",
);
const verifyEmbeddedGitNoticesPath = resolve(
  repoRoot,
  "apps/desktop/scripts/verify-embedded-git-notices.mjs",
);
const windowsArchiveScriptPath = resolve(
  repoRoot,
  "scripts/release/archive-windows-signing-input.ps1",
);
const trustedSigningScriptPath = resolve(
  repoRoot,
  "scripts/release/install-trusted-signing.ps1",
);
const changelogPath = resolve(repoRoot, "CHANGELOG.md");

function usage() {
  console.error("Usage: RELEASE_TAG=v0.0.1-alpha.1 pnpm release:check");
  console.error("   or: pnpm release:check --tag v0.0.1-alpha.1");
  console.error("   or: pnpm release:check --tag v0.0.1-alpha.1 --notes-file /tmp/RELEASE_NOTES.md");
}

function parseTagArg(argv) {
  const tagIndex = argv.indexOf("--tag");
  if (tagIndex !== -1) {
    return argv[tagIndex + 1] || "";
  }
  const inline = argv.find((arg) => arg.startsWith("--tag="));
  if (inline) {
    return inline.slice("--tag=".length);
  }
  return process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
}

function parseNotesFileArg(argv) {
  const notesFileIndex = argv.indexOf("--notes-file");
  if (notesFileIndex !== -1) {
    return argv[notesFileIndex + 1] || "";
  }
  const inline = argv.find((arg) => arg.startsWith("--notes-file="));
  if (inline) {
    return inline.slice("--notes-file=".length);
  }
  return undefined;
}

function fail(message) {
  console.error(`release metadata check failed: ${message}`);
  process.exitCode = 1;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelogSection(changelog, version) {
  const headingPattern = new RegExp(`^##\\s+v?${escapeRegex(version)}(?:\\s|$)`);
  const nextHeadingPattern = /^##\s+/;
  const lines = changelog.split(/\r?\n/);
  const section = [];
  let inSection = false;

  for (const line of lines) {
    if (!inSection && headingPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && nextHeadingPattern.test(line)) {
      break;
    }
    if (inSection) {
      section.push(line);
    }
  }

  return section.join("\n").trim();
}

function workflowJobBody(workflow, jobName) {
  const jobPattern = new RegExp(`^  ${escapeRegex(jobName)}:\\n`, "m");
  const match = workflow.match(jobPattern);
  if (!match) {
    fail(`.github/workflows/release.yml must contain a ${jobName} job`);
    return "";
  }
  const bodyStart = match.index + match[0].length;
  const remainder = workflow.slice(bodyStart);
  const nextJobOffset = remainder.search(/^  [A-Za-z0-9_-]+:/m);
  return nextJobOffset === -1
    ? remainder
    : remainder.slice(0, nextJobOffset);
}

function assertContains(source, sourceName, expected) {
  if (!source.includes(expected)) {
    fail(`${sourceName} must contain ${JSON.stringify(expected)}`);
  }
}

function assertExcludes(source, sourceName, unexpected) {
  if (source.includes(unexpected)) {
    fail(`${sourceName} must not contain ${JSON.stringify(unexpected)}`);
  }
}

const argv = process.argv.slice(2);
const tag = parseTagArg(argv);
if (!tag) {
  usage();
  fail("no release tag was provided");
  process.exit();
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`tag "${tag}" must look like vX.Y.Z or vX.Y.Z-prerelease`);
}

const expectedVersion = tag.slice(1);
const notesFile = parseNotesFileArg(argv);
if (notesFile === "") {
  usage();
  fail("--notes-file requires a path");
}
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
if (desktopPackage.version !== expectedVersion) {
  fail(
    `apps/desktop/package.json version is ${desktopPackage.version}, but release tag ${tag} requires ${expectedVersion}`,
  );
}

const electronBuilder = readFileSync(electronBuilderPath, "utf8");
if (!/^\s*releaseType:\s*prerelease\s*$/m.test(electronBuilder)) {
  fail("apps/desktop/electron-builder.yml publish.releaseType must be prerelease");
}

const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
const workflowsReadme = readFileSync(workflowsReadmePath, "utf8");
const releaseScript = readFileSync(releaseScriptPath, "utf8");
const verifyAsarContents = readFileSync(verifyAsarContentsPath, "utf8");
const verifyEmbeddedGitNotices = readFileSync(
  verifyEmbeddedGitNoticesPath,
  "utf8",
);
const windowsArchiveScript = readFileSync(windowsArchiveScriptPath, "utf8");
const trustedSigningScript = readFileSync(trustedSigningScriptPath, "utf8");

for (const expected of [
  "pull_request:",
  "ci:windows-signing",
  "github.event.pull_request.head.repo.full_name == github.repository",
  "  linux-build:",
  "  windows-prepare:",
  "  windows-sign:",
  "  publish-release-assets:",
  "windows-release-signing-input",
  "windows-signed-installer-pr",
  "Get-AuthenticodeSignature",
  "if: ${{ github.event_name != 'pull_request' }}",
]) {
  assertContains(releaseWorkflow, ".github/workflows/release.yml", expected);
}
for (const unexpected of [
  "pull_request_target",
  "WINDOWS_UNSIGNED_RELEASE",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
]) {
  assertExcludes(releaseWorkflow, ".github/workflows/release.yml", unexpected);
}

const windowsPrepareJob = workflowJobBody(releaseWorkflow, "windows-prepare");
for (const expected of [
  "runs-on: windows-2022",
  "--win --prepare-only",
  "archive-windows-signing-input.ps1",
  "signing-input-sha256: ${{ steps.archive.outputs.sha256 }}",
]) {
  assertContains(windowsPrepareJob, ".github/workflows/release.yml windows-prepare", expected);
}
for (const unexpected of [
  "environment: windows-signing",
  "secrets.",
  "--require-signing",
]) {
  assertExcludes(windowsPrepareJob, ".github/workflows/release.yml windows-prepare", unexpected);
}

const windowsSignJob = workflowJobBody(releaseWorkflow, "windows-sign");
for (const expected of [
  "runs-on: windows-2022",
  "environment: windows-signing",
  "Download Windows signing input",
  "Verify Windows signing input",
  "scripts/release/install-trusted-signing.ps1",
  "--win --sign-stage-only --no-publish --require-signing",
  "vars.WIN_AZURE_SIGN_PUBLISHER_NAME",
  "secrets.AZURE_CLIENT_SECRET",
]) {
  assertContains(windowsSignJob, ".github/workflows/release.yml windows-sign", expected);
}
for (const unexpected of [
  "actions/checkout@",
  "pnpm install",
  "npm install",
]) {
  assertExcludes(windowsSignJob, ".github/workflows/release.yml windows-sign", unexpected);
}
for (const credential of [
  "vars.WIN_AZURE_SIGN_PUBLISHER_NAME",
  "vars.WIN_AZURE_SIGN_ENDPOINT",
  "vars.WIN_AZURE_SIGN_ACCOUNT",
  "vars.WIN_AZURE_SIGN_PROFILE",
  "secrets.AZURE_TENANT_ID",
  "secrets.AZURE_CLIENT_ID",
  "secrets.AZURE_CLIENT_SECRET",
]) {
  assertContains(windowsSignJob, ".github/workflows/release.yml windows-sign", credential);
  assertExcludes(
    releaseWorkflow.replace(windowsSignJob, ""),
    ".github/workflows/release.yml outside windows-sign",
    credential,
  );
}

const macSignJob = workflowJobBody(releaseWorkflow, "sign");
for (const expected of [
  "--sign-stage-only --no-publish",
  "Upload macOS release assets",
]) {
  assertContains(macSignJob, ".github/workflows/release.yml sign", expected);
}
for (const unexpected of ["gh release upload", "contents: write"]) {
  assertExcludes(macSignJob, ".github/workflows/release.yml sign", unexpected);
}

const publishJob = workflowJobBody(releaseWorkflow, "publish-release-assets");
for (const expected of [
  "- linux-build",
  "- sign",
  "- windows-sign",
  "Download macOS release artifacts",
  "Download Windows installer artifact",
  "Name Windows checksum manifest",
  "gh release create",
  "--verify-tag",
  "find mac-dist -type f",
  "find windows-dist -type f",
  '"${mac_assets[@]}"',
  '"${windows_assets[@]}"',
]) {
  assertContains(publishJob, ".github/workflows/release.yml publish-release-assets", expected);
}
for (const unexpected of ["mac-dist/*", "windows-dist/*", "gh release upload"]) {
  assertExcludes(publishJob, ".github/workflows/release.yml publish-release-assets", unexpected);
}

for (const expected of [
  "resolveWindowsAzureSigning",
  "signStageOnly && win",
  "--config.node-linker=hoisted",
  "--config.win.azureSignOptions.publisherName",
  "PWRGIT_ASAR_MODULE_ROOT",
  "PWRGIT_NOTICE_SOURCE_ROOT",
  "--require-signing",
]) {
  assertContains(releaseScript, "apps/desktop/scripts/release.mjs", expected);
}
for (const unexpected of ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) {
  assertExcludes(releaseScript, "apps/desktop/scripts/release.mjs", unexpected);
}
assertContains(
  verifyAsarContents,
  "apps/desktop/scripts/verify-asar-contents.mjs",
  "PWRGIT_ASAR_MODULE_ROOT",
);
assertContains(
  verifyEmbeddedGitNotices,
  "apps/desktop/scripts/verify-embedded-git-notices.mjs",
  "PWRGIT_NOTICE_SOURCE_ROOT",
);
for (const expected of [
  "apps/desktop/release-stage/node_modules/.pnpm/node_modules",
  "apps/desktop/release-stage",
  "apps/desktop/scripts/release.mjs",
  "scripts/release/install-trusted-signing.ps1",
  "tar.exe -czf",
]) {
  assertContains(
    windowsArchiveScript,
    "scripts/release/archive-windows-signing-input.ps1",
    expected,
  );
}
for (const expected of [
  "Install-Module",
  "-Name TrustedSigning",
  "-MinimumVersion 0.5.0",
  "Get-Command Invoke-TrustedSigning",
  "-NoProfile -NonInteractive -Command",
]) {
  assertContains(
    trustedSigningScript,
    "scripts/release/install-trusted-signing.ps1",
    expected,
  );
}
for (const expected of [
  "ci:windows-signing",
  "refs/pull/<number>/merge",
  "pull_request_target",
]) {
  assertContains(workflowsReadme, ".github/workflows/README.md", expected);
}

let changelog = "";
try {
  changelog = readFileSync(changelogPath, "utf8");
} catch (error) {
  if (error && error.code === "ENOENT") {
    fail("CHANGELOG.md is missing");
  } else {
    throw error;
  }
}

const headingPattern = new RegExp(`^##\\s+v?${escapeRegex(expectedVersion)}(?:\\s|$)`, "m");
if (!headingPattern.test(changelog)) {
  fail(`CHANGELOG.md must contain a second-level heading for ${tag}`);
}

const releaseNotes = extractChangelogSection(changelog, expectedVersion);
if (releaseNotes.length === 0) {
  fail(`CHANGELOG.md section for ${tag} must contain release notes`);
}

if (process.exitCode) {
  process.exit();
}

if (notesFile) {
  writeFileSync(notesFile, `${releaseNotes}\n`);
  console.log(`release metadata check passed for ${tag}; wrote notes to ${notesFile}`);
} else {
  console.log(`release metadata check passed for ${tag}`);
}
