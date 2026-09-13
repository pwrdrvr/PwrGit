#!/usr/bin/env node
// Walks the packaged app.asar and fails the build if any forbidden file
// pattern slips into the bundle. Mirrors the exclusions in
// electron-builder.yml so a regression is caught loudly even if the YAML is
// edited carelessly.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  asarExtractPath,
  findRemoteScript,
  isRendererHtmlEntry,
} from "./packaged-html-rules.mjs";

const args = process.argv.slice(2);
const appPath = args[0]
  ?? resolve("release-stage/dist/mac-universal/PwrGit.app");

function resolveAsarPath(path) {
  const directAsarPath = resolve(path);
  if (directAsarPath.endsWith(".asar") && existsSync(directAsarPath)) {
    return directAsarPath;
  }

  const macAsarPath = resolve(path, "Contents/Resources/app.asar");
  if (existsSync(macAsarPath)) {
    return macAsarPath;
  }

  // Windows and Linux unpacked apps share the resources/ layout.
  const flatAsarPath = resolve(path, "resources/app.asar");
  if (existsSync(flatAsarPath)) {
    return flatAsarPath;
  }

  return macAsarPath;
}

const asarPath = resolveAsarPath(appPath);
if (!existsSync(asarPath)) {
  console.error(`verify-asar-contents: app.asar not found at ${asarPath}`);
  process.exit(1);
}

// @electron/asar is a transitive dependency of electron-builder. The protected
// Windows signing job receives a self-contained staged toolchain rather than
// the workspace node_modules, so allow release.mjs to resolve from that stage
// without reinstalling dependencies around signing credentials.
const asarModuleRoot = process.env.PWRGIT_ASAR_MODULE_ROOT?.trim();
const require = asarModuleRoot
  ? createRequire(resolve(asarModuleRoot, "package.json"))
  : createRequire(import.meta.url);
const asar = require("@electron/asar");
// listPackage returns platform-separator paths (backslashes on Windows);
// normalize so the required-file and forbidden-pattern checks below match on
// every platform.
const listing = asar
  .listPackage(asarPath, { isPack: false })
  .map((entry) => entry.replace(/\\/g, "/"));
const required = [
  "/out/main/index.js",
];

const missing = required.filter((entry) => !listing.includes(entry));
if (missing.length > 0) {
  console.error(
    `verify-asar-contents: missing required packaged file(s): ${missing.join(", ")}`,
  );
  process.exit(1);
}

// Each rule: [label, regex]. Anything matching → fail.
const forbidden = [
  ["TypeScript source", /\.tsx?$/],
  ["TypeScript declaration", /\.d\.ts$/],
  ["Sourcemap", /\.map$/],
  ["tsconfig", /(^|\/)tsconfig.*\.json$/],
  ["Test file", /\.(test|spec)\.[cm]?[jt]sx?$/],
  ["__tests__ dir", /\/__tests__\//],
  ["e2e dir", /\/e2e\//],
  ["Markdown", /\.mdx?$/],
  ["docs dir", /\/docs\//],
  ["Env example", /\/\.env(\.|$)/],
  ["Workspace src/ leak", /\/node_modules\/@pwrgit\/[^/]+\/src\//],
  ["Workspace AGENTS.md", /\/node_modules\/@pwrgit\/[^/]+\/AGENTS\.md$/],
  [
    "Screenshot/design image",
    /(^|\/)[^/]*(screenshot|screenie|capture|mockup|wireframe|prototype|design)[^/]*\.(png|jpg|jpeg|gif|tiff|psd|sketch|fig)$/i,
  ],
  ["Playwright config", /playwright\.config\./],
  ["better-sqlite3 dev sidecar", /\/node_modules\/better-sqlite3\/electron-native\//],
  ["better-sqlite3 packaged prebuild", /\/node_modules\/better-sqlite3\/prebuilds\//],
  ["Project plan/brainstorm", /\/(plans|brainstorms|design)\//],
];

const violations = [];
for (const entry of listing) {
  for (const [label, pattern] of forbidden) {
    if (pattern.test(entry)) {
      violations.push({ label, entry });
      break;
    }
  }
}

if (violations.length > 0) {
  const grouped = new Map();
  for (const { label, entry } of violations) {
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(entry);
  }
  console.error(`\nverify-asar-contents: ${violations.length} forbidden file(s) in app.asar\n`);
  for (const [label, entries] of grouped) {
    console.error(`  [${label}] ${entries.length} match(es):`);
    for (const e of entries.slice(0, 5)) console.error(`    ${e}`);
    if (entries.length > 5) console.error(`    … and ${entries.length - 5} more`);
  }
  console.error(`\nUpdate apps/desktop/electron-builder.yml \`files:\` exclusions to drop these.`);
  process.exit(1);
}

// A packaged renderer must load every script from inside the asar. The one
// thing that has ever wanted to break that rule is the dev-only React DevTools
// bridge (PWRGIT_REACT_DEVTOOLS), which injects
// `<script src="http://localhost:8097">` as the first head script at Vite
// config time. That is a build-time decision, so nothing at app runtime can
// undo it — this is where it gets caught. The rule is written against the
// shape, not against the flag, so any remote script trips it.
//
// An entry that cannot be read fails the gate rather than being skipped. This
// is a check whose whole job is to stop something shipping, so "could not
// look" has to be as loud as "looked and found it" — a silent skip would let
// the exact file the gate exists for pass unexamined. (`extractFile` does read
// unpacked files out of the `.unpacked` sidecar, so what throws here is a
// directory, a link, or real I/O trouble — all of which mean the bundle was
// not cleared.)
const remoteScriptViolations = [];
const unreadableHtmlEntries = [];
const rendererHtmlEntries = listing.filter(isRendererHtmlEntry);

// Finding nothing to scan is a failure, not a pass. The bundle always carries
// at least the renderer's index.html, so an empty match means the layout moved
// out from under this rule — and a gate that silently inspects no files is
// indistinguishable from one that inspected them and approved. Same reasoning
// as the unreadable-entry branch below, and as the `required` list above.
if (rendererHtmlEntries.length === 0) {
  console.error(
    "\nverify-asar-contents: no renderer HTML found under /out/ to scan\n",
  );
  console.error(
    "  The remote-script rule inspected nothing, so the bundle is not cleared."
    + "\n  Renderer HTML has moved; update isRendererHtmlEntry in"
    + "\n  scripts/packaged-html-rules.mjs to match the new layout.",
  );
  process.exit(1);
}

for (const entry of rendererHtmlEntries) {
  let contents;
  try {
    contents = asar.extractFile(asarPath, asarExtractPath(entry)).toString("utf8");
  } catch (error) {
    unreadableHtmlEntries.push({ entry, reason: error?.message || String(error) });
    continue;
  }
  const snippet = findRemoteScript(contents);
  if (snippet) {
    remoteScriptViolations.push({ entry, snippet });
  }
}

if (remoteScriptViolations.length > 0 || unreadableHtmlEntries.length > 0) {
  if (remoteScriptViolations.length > 0) {
    console.error(
      `\nverify-asar-contents: ${remoteScriptViolations.length} packaged HTML file(s) load a remote script\n`,
    );
    for (const { entry, snippet } of remoteScriptViolations) {
      console.error(`  ${entry}`);
      console.error(`    ${snippet}`);
    }
    console.error(
      "\nBuild without PWRGIT_REACT_DEVTOOLS set. That bridge is for local"
      + "\nprofiling builds only and must never reach a packaged app.",
    );
  }
  if (unreadableHtmlEntries.length > 0) {
    console.error(
      `\nverify-asar-contents: ${unreadableHtmlEntries.length} packaged HTML file(s) could not be read\n`,
    );
    for (const { entry, reason } of unreadableHtmlEntries) {
      console.error(`  ${entry}`);
      console.error(`    ${reason}`);
    }
    console.error(
      "\nThese were not inspected for remote scripts, so the bundle is not cleared."
      + "\nA renderer HTML entry should be a readable, packed file.",
    );
  }
  process.exit(1);
}

console.log(
  `verify-asar-contents: OK (${listing.length} entries, main bundle present, no forbidden patterns, no remote scripts)`,
);
