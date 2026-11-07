#!/usr/bin/env node
// Release metadata gate, ported from PwrSnap. Verifies that a release tag,
// apps/desktop/package.json, electron-builder.yml, and CHANGELOG.md all agree
// before any signing/publishing work starts, and can extract the changelog
// section as release notes for `gh release edit`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file the gate reads, relative to the repository root. */
export const RELEASE_METADATA_SOURCES = {
  desktopPackage: "apps/desktop/package.json",
  electronBuilder: "apps/desktop/electron-builder.yml",
  releaseWorkflow: ".github/workflows/release.yml",
  workflowsReadme: ".github/workflows/README.md",
  releaseScript: "apps/desktop/scripts/release.mjs",
  verifyAsarContents: "apps/desktop/scripts/verify-asar-contents.mjs",
  verifyEmbeddedGitNotices: "apps/desktop/scripts/verify-embedded-git-notices.mjs",
  windowsArchiveScript: "scripts/release/archive-windows-signing-input.ps1",
  trustedSigningScript: "scripts/release/install-trusted-signing.ps1",
  changelog: "CHANGELOG.md",
};

/**
 * The text every check below reads: LF line endings, no byte-order mark.
 *
 * The checks match multi-line snippets (`concurrency:\n  jobs: 1`) and
 * line-anchored job headers, so a CRLF checkout used to read as "job
 * missing" (#96), and a BOM made `JSON.parse` throw. Git for Windows
 * defaults to `core.autocrlf=true`, and editors there may add a BOM; the
 * repo's `.gitattributes` prevents both today, but the gate must not depend
 * on it.
 */
export function normalizeText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractChangelogSection(changelog, version) {
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

function workflowJobBody(workflow, jobName, fail) {
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

function assertContains(source, sourceName, expected, fail) {
  if (!source.includes(expected)) {
    fail(`${sourceName} must contain ${JSON.stringify(expected)}`);
  }
}

function assertExcludes(source, sourceName, unexpected, fail) {
  if (source.includes(unexpected)) {
    fail(`${sourceName} must not contain ${JSON.stringify(unexpected)}`);
  }
}

/**
 * Read every source the gate checks. `changelog` is `undefined` when
 * CHANGELOG.md does not exist; any other read error propagates.
 */
export function readReleaseMetadataSources(root = repoRoot) {
  const sources = {};
  for (const [key, path] of Object.entries(RELEASE_METADATA_SOURCES)) {
    try {
      sources[key] = readFileSync(resolve(root, path), "utf8");
    } catch (error) {
      if (key === "changelog" && error && error.code === "ENOENT") {
        sources[key] = undefined;
      } else {
        throw error;
      }
    }
  }
  return sources;
}

/**
 * Check that `tag`, the desktop package, electron-builder.yml, the release
 * workflow and CHANGELOG.md agree. Returns every failure, in the order found,
 * and the changelog section for the tag.
 */
export function checkReleaseMetadata(tag, sources) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const text = Object.fromEntries(
    Object.entries(sources).map(([key, value]) => [
      key,
      value === undefined ? undefined : normalizeText(value),
    ]),
  );

  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    fail(`tag "${tag}" must look like vX.Y.Z or vX.Y.Z-prerelease`);
  }
  const expectedVersion = tag.slice(1);

  const desktopPackage = JSON.parse(text.desktopPackage);
  if (desktopPackage.version !== expectedVersion) {
    fail(
      `apps/desktop/package.json version is ${desktopPackage.version}, but release tag ${tag} requires ${expectedVersion}`,
    );
  }

  const { electronBuilder } = text;
  if (!/^\s*releaseType:\s*prerelease\s*$/m.test(electronBuilder)) {
    fail("apps/desktop/electron-builder.yml publish.releaseType must be prerelease");
  }
  if ((electronBuilder.match(/arch: \[universal, arm64\]/g) ?? []).length !== 2) {
    fail("macOS DMG and ZIP targets must both include universal and arm64");
  }
  assertContains(electronBuilder, "apps/desktop/electron-builder.yml", "concurrency:\n  jobs: 1", fail);

  const { releaseWorkflow } = text;
  const { workflowsReadme } = text;
  const { releaseScript } = text;
  assertContains(releaseScript, "apps/desktop/scripts/release.mjs", "writeMacReleaseArtifacts(dist,", fail);
  assertContains(releaseWorkflow, ".github/workflows/release.yml", "apps/desktop/scripts/mac-release-artifacts.mjs", fail);
  const { verifyAsarContents } = text;
  const { verifyEmbeddedGitNotices } = text;
  const { windowsArchiveScript } = text;
  const { trustedSigningScript } = text;

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
    assertContains(releaseWorkflow, ".github/workflows/release.yml", expected, fail);
  }
  for (const unexpected of [
    "pull_request_target",
    "WINDOWS_UNSIGNED_RELEASE",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
  ]) {
    assertExcludes(releaseWorkflow, ".github/workflows/release.yml", unexpected, fail);
  }

  const windowsPrepareJob = workflowJobBody(releaseWorkflow, "windows-prepare", fail);
  for (const expected of [
    "runs-on: windows-2022",
    "--win --prepare-only",
    "archive-windows-signing-input.ps1",
    "signing-input-sha256: ${{ steps.archive.outputs.sha256 }}",
  ]) {
    assertContains(windowsPrepareJob, ".github/workflows/release.yml windows-prepare", expected, fail);
  }
  for (const unexpected of [
    "environment: windows-signing",
    "secrets.",
    "--require-signing",
  ]) {
    assertExcludes(windowsPrepareJob, ".github/workflows/release.yml windows-prepare", unexpected, fail);
  }

  const windowsSignJob = workflowJobBody(releaseWorkflow, "windows-sign", fail);
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
    assertContains(windowsSignJob, ".github/workflows/release.yml windows-sign", expected, fail);
  }
  for (const unexpected of [
    "actions/checkout@",
    "pnpm install",
    "npm install",
  ]) {
    assertExcludes(windowsSignJob, ".github/workflows/release.yml windows-sign", unexpected, fail);
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
    assertContains(windowsSignJob, ".github/workflows/release.yml windows-sign", credential, fail);
    assertExcludes(
      releaseWorkflow.replace(windowsSignJob, ""),
      ".github/workflows/release.yml outside windows-sign",
      credential,
      fail,
    );
  }

  const macSignJob = workflowJobBody(releaseWorkflow, "sign", fail);
  for (const expected of [
    "--sign-stage-only --no-publish",
    "Upload macOS release assets",
  ]) {
    assertContains(macSignJob, ".github/workflows/release.yml sign", expected, fail);
  }
  for (const unexpected of ["gh release upload", "contents: write"]) {
    assertExcludes(macSignJob, ".github/workflows/release.yml sign", unexpected, fail);
  }

  const publishJob = workflowJobBody(releaseWorkflow, "publish-release-assets", fail);
  for (const expected of [
    "- linux-build",
    "- sign",
    "- windows-sign",
    "Download macOS release artifacts",
    "Download Windows installer artifact",
    "Name Windows checksum manifest",
    'node scripts/publish-desktop-release.mjs "$RELEASE_TAG" mac-dist windows-dist linux-dist "$notes"',
    "cancel-in-progress: false",
  ]) {
    assertContains(publishJob, ".github/workflows/release.yml publish-release-assets", expected, fail);
  }
  for (const unexpected of ["mac-dist/*", "windows-dist/*", "gh release upload", "gh release create"]) {
    assertExcludes(publishJob, ".github/workflows/release.yml publish-release-assets", unexpected, fail);
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
    assertContains(releaseScript, "apps/desktop/scripts/release.mjs", expected, fail);
  }
  for (const unexpected of ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) {
    assertExcludes(releaseScript, "apps/desktop/scripts/release.mjs", unexpected, fail);
  }
  assertContains(
    verifyAsarContents,
    "apps/desktop/scripts/verify-asar-contents.mjs",
    "PWRGIT_ASAR_MODULE_ROOT",
    fail,
  );
  assertContains(
    verifyEmbeddedGitNotices,
    "apps/desktop/scripts/verify-embedded-git-notices.mjs",
    "PWRGIT_NOTICE_SOURCE_ROOT",
    fail,
  );
  for (const expected of [
    "apps/desktop/release-stage/node_modules/.pnpm/node_modules",
    "apps/desktop/release-stage",
    "apps/desktop/scripts/release.mjs",
    "apps/desktop/scripts/mac-release-artifacts.mjs",
    "scripts/release/install-trusted-signing.ps1",
    "tar.exe -czf",
  ]) {
    assertContains(
      windowsArchiveScript,
      "scripts/release/archive-windows-signing-input.ps1",
      expected,
      fail,
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
      fail,
    );
  }
  for (const expected of [
    "ci:windows-signing",
    "refs/pull/<number>/merge",
    "pull_request_target",
  ]) {
    assertContains(workflowsReadme, ".github/workflows/README.md", expected, fail);
  }

  if (text.changelog === undefined) {
    fail("CHANGELOG.md is missing");
  }
  const changelog = text.changelog ?? "";

  const headingPattern = new RegExp(`^##\\s+v?${escapeRegex(expectedVersion)}(?:\\s|$)`, "m");
  if (!headingPattern.test(changelog)) {
    fail(`CHANGELOG.md must contain a second-level heading for ${tag}`);
  }

  const releaseNotes = extractChangelogSection(changelog, expectedVersion);
  if (releaseNotes.length === 0) {
    fail(`CHANGELOG.md section for ${tag} must contain release notes`);
  }

  return { failures, releaseNotes };
}

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

function runCli(argv) {
  const fail = (message) => {
    console.error(`release metadata check failed: ${message}`);
    process.exitCode = 1;
  };
  const tag = parseTagArg(argv);
  if (!tag) {
    usage();
    fail("no release tag was provided");
    return;
  }
  const notesFile = parseNotesFileArg(argv);
  if (notesFile === "") {
    usage();
    fail("--notes-file requires a path");
  }

  const { failures, releaseNotes } = checkReleaseMetadata(
    tag,
    readReleaseMetadataSources(),
  );
  for (const failure of failures) fail(failure);
  if (process.exitCode) return;

  if (notesFile) {
    writeFileSync(notesFile, `${releaseNotes}\n`);
    console.log(`release metadata check passed for ${tag}; wrote notes to ${notesFile}`);
  } else {
    console.log(`release metadata check passed for ${tag}`);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  runCli(process.argv.slice(2));
}
