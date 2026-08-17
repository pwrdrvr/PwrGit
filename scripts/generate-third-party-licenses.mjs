#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(repoRoot, "THIRD_PARTY_LICENSES");
const desktopFilter = "@pwrgit/desktop";
const embeddedGitNoticeDir = join(
  repoRoot,
  "apps",
  "desktop",
  "resources",
  "embedded-git",
);

// Dugite downloads and ships this runtime outside npm's package inventory.
// Keep the versions and source URLs in sync with its embedded-git.json when
// updating the dugite dependency.
const EMBEDDED_GIT_NOTICE_SOURCES = [
  {
    name: "Git embedded runtime",
    version: "2.53.0",
    declaredLicense: "GPL-2.0-only",
    file: "COPYING",
    source: "https://github.com/desktop/dugite-native/tree/v2.53.0-4",
  },
  {
    name: "Git LFS embedded runtime",
    version: "3.7.1",
    declaredLicense: "MIT",
    file: "LICENSE.git-lfs",
    source: "https://github.com/git-lfs/git-lfs/tree/v3.7.1",
  },
  {
    name: "Git Credential Manager embedded runtime",
    version: "2.9.0",
    declaredLicense: "MIT",
    file: "LICENSE.git-credential-manager",
    source: "https://github.com/git-ecosystem/git-credential-manager/tree/v2.9.0",
  },
  {
    name: "Git Credential Manager notices",
    version: "2.9.0",
    declaredLicense: "MIT",
    file: "NOTICE",
    source: "https://github.com/git-ecosystem/git-credential-manager/tree/v2.9.0",
  },
];

function runPnpmLicenses(args) {
  const result = spawnSync(
    "pnpm",
    ["licenses", "list", "--json", "--filter", desktopFilter, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      // Windows resolves `pnpm` via the pnpm.cmd shim, which spawnSync only
      // finds through a shell. Without this, spawn fails with ENOENT and
      // result.status/stderr are null (crashing the undefined-stderr write).
      shell: process.platform === "win32",
    },
  );
  if (result.error) {
    process.stderr.write(`failed to run pnpm licenses: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "pnpm licenses list failed\n");
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

function flattenLicenseReport(report) {
  const records = [];
  for (const [declaredLicense, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const versions = entry.versions?.length ? entry.versions : [""];
      const paths = entry.paths?.length ? entry.paths : [undefined];
      for (let index = 0; index < versions.length; index += 1) {
        records.push({
          name: entry.name,
          version: versions[index] ?? versions[0] ?? "",
          declaredLicense,
          packagePath: paths[index] ?? paths[0],
          homepage: entry.homepage,
          author: entry.author,
          description: entry.description,
        });
      }
    }
  }
  return records;
}

export class StaleInstallError extends Error {
  constructor(record, detail) {
    super(
      [
        `Cannot generate THIRD_PARTY_LICENSES for ${stableRecordKey(record)}: ${detail}.`,
        "The installed dependencies are stale or incomplete. Run `pnpm install`, then rerun the license command.",
      ].join("\n"),
    );
    this.name = "StaleInstallError";
  }
}

function readPackageJson(record) {
  if (!record.packagePath) {
    throw new StaleInstallError(
      record,
      "`pnpm licenses` did not report an installed package path",
    );
  }
  if (!existsSync(record.packagePath)) {
    throw new StaleInstallError(
      record,
      `\`pnpm licenses\` reported package path "${record.packagePath}", but that directory does not exist`,
    );
  }
  const packageJsonPath = join(record.packagePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new StaleInstallError(
      record,
      `\`pnpm licenses\` reported package path "${record.packagePath}", but "${packageJsonPath}" does not exist`,
    );
  }
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function normalizeRepository(repository) {
  const raw =
    typeof repository === "string"
      ? repository
      : repository && typeof repository.url === "string"
        ? repository.url
        : undefined;
  if (!raw) {
    return undefined;
  }
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function npmPackageUrl(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(name).replace(
    "%40",
    "@",
  )}`;
}

function findLicenseFile(packagePath) {
  if (!packagePath || !existsSync(packagePath)) {
    return undefined;
  }
  const candidates = readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(licen[cs]e|copying|copyright)(?:[.-].*)?$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  return candidates[0] ? join(packagePath, candidates[0]) : undefined;
}

function formatAuthor(author) {
  if (!author) {
    return undefined;
  }
  if (typeof author === "string") {
    return author;
  }
  if (typeof author.name === "string") {
    return author.name;
  }
  return undefined;
}

function declaredLicenseFallbackText(record, packageJson) {
  if (record.declaredLicense === "MIT") {
    const holder = formatAuthor(packageJson?.author) ?? record.name;
    return `The installed package does not include a separate license file. Its package metadata declares MIT.

MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  }

  return [
    `No license text file was found in the installed package for ${stableRecordKey(
      record,
    )}.`,
    `The package declares license: ${record.declaredLicense}.`,
  ].join("\n");
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeLicenseText(text) {
  return normalizeLineEndings(text).trim();
}

function normalizePathForNotice(path) {
  return path.split(sep).join("/");
}

function readEmbeddedGitNoticeRecords() {
  return EMBEDDED_GIT_NOTICE_SOURCES.map((notice) => {
    const path = join(embeddedGitNoticeDir, notice.file);
    if (!existsSync(path)) {
      throw new Error(
        `Embedded Git runtime notice is missing at ${relative(repoRoot, path)}.`,
      );
    }
    const licenseText = normalizeLicenseText(readFileSync(path, "utf8"));
    return {
      ...notice,
      // `THIRD_PARTY_LICENSES` is committed, so its source paths must not
      // depend on whether it was generated on Windows or POSIX.
      licenseFile: normalizePathForNotice(relative(repoRoot, path)),
      licenseText,
      licenseTextHash: createHash("sha256").update(licenseText).digest("hex"),
    };
  });
}

function stableRecordKey(record) {
  return `${record.name}@${record.version}`;
}

export function enrichRecord(record) {
  const packageJson = readPackageJson(record);
  const licensePath = findLicenseFile(record.packagePath);
  const licenseText = licensePath
    ? normalizeLicenseText(readFileSync(licensePath, "utf8"))
    : declaredLicenseFallbackText(record, packageJson);
  return {
    ...record,
    source:
      normalizeRepository(packageJson?.repository) ??
      packageJson?.homepage ??
      record.homepage ??
      npmPackageUrl(record.name),
    licenseFile: licensePath
      ? relative(record.packagePath, licensePath)
      : "package metadata",
    licenseText,
    licenseTextHash: createHash("sha256").update(licenseText).digest("hex"),
  };
}

function compareRecords(a, b) {
  return (
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.declaredLicense.localeCompare(b.declaredLicense)
  );
}

function main() {
  const check = process.argv.includes("--check");
  // Optional dependencies are platform-specific. Excluding them keeps this
  // committed notice deterministic across macOS, Linux, and Windows CI.
  const productionRecords = flattenLicenseReport(
    runPnpmLicenses(["--prod", "--no-optional"]),
  );
  const allRecords = flattenLicenseReport(runPnpmLicenses(["--no-optional"]));
  const recordsByKey = new Map();

  for (const record of productionRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }

  for (const record of allRecords) {
    if (record.name === "electron") {
      recordsByKey.set(stableRecordKey(record), record);
    }
  }

  const records = [
    ...Array.from(recordsByKey.values()).sort(compareRecords).map(enrichRecord),
    ...readEmbeddedGitNoticeRecords(),
  ].sort(compareRecords);

  const recordsByLicense = new Map();
  for (const record of records) {
    const group = recordsByLicense.get(record.declaredLicense) ?? [];
    group.push(record);
    recordsByLicense.set(record.declaredLicense, group);
  }

  const textGroups = new Map();
  for (const record of records) {
    const group = textGroups.get(record.licenseTextHash) ?? {
      declaredLicenses: new Set(),
      records: [],
      text: record.licenseText,
      representative: record,
    };
    group.declaredLicenses.add(record.declaredLicense);
    group.records.push(record);
    textGroups.set(record.licenseTextHash, group);
  }

  const lines = [];
  lines.push("PwrGit Third-Party Licenses");
  lines.push("===========================");
  lines.push("");
  lines.push("Generated by scripts/generate-third-party-licenses.mjs.");
  lines.push("Do not edit this file manually; run `pnpm licenses:generate`.");
  lines.push("");
  lines.push("Scope");
  lines.push("-----");
  lines.push("");
  lines.push(
    "This notice covers npm production dependencies for @pwrgit/desktop plus the Electron runtime package.",
  );
  lines.push(
    "Electron includes Chromium and Node.js runtime components. PwrGit includes Electron's MIT runtime license here; Chromium's generated credits are maintained upstream by Chromium/Electron and are intentionally not appended to this text notice because Electron's generated LICENSES.chromium.html is large for the pinned runtime.",
  );
  lines.push(
    "For Chromium runtime credits, see https://source.chromium.org/chromium and Electron's packaged LICENSES.chromium.html in the corresponding Electron release.",
  );
  lines.push(
    "The renderer build emits Geist Sans and Geist Mono webfont assets from @fontsource/geist-sans and @fontsource/geist-mono. Those packages are listed below under OFL-1.1, and their SIL Open Font License text is included in the License Texts section.",
  );
  lines.push(
    "PwrGit also bundles Git, Git LFS, and Git Credential Manager through Dugite outside the npm dependency tree. Their COPYING, LICENSE, and NOTICE files are installed beside the runtime under Resources/git and are included below.",
  );
  lines.push("");
  lines.push("Dependency Summary");
  lines.push("------------------");
  lines.push("");

  for (const [declaredLicense, group] of Array.from(recordsByLicense.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    lines.push(`${declaredLicense}`);
    lines.push("~".repeat(declaredLicense.length));
    for (const record of group.sort(compareRecords)) {
      lines.push(`- ${stableRecordKey(record)} | ${record.source}`);
    }
    lines.push("");
  }

  lines.push("License Texts");
  lines.push("-------------");
  lines.push("");

  const sortedTextGroups = Array.from(textGroups.values()).sort((a, b) => {
    const aFirst = a.records.slice().sort(compareRecords)[0];
    const bFirst = b.records.slice().sort(compareRecords)[0];
    return compareRecords(aFirst, bFirst);
  });

  for (const group of sortedTextGroups) {
    const appliesTo = group.records.slice().sort(compareRecords);
    const licenses = Array.from(group.declaredLicenses).sort().join(", ");
    lines.push(`${stableRecordKey(group.representative)} (${licenses})`);
    lines.push("-".repeat(`${stableRecordKey(group.representative)} (${licenses})`.length));
    lines.push("");
    lines.push("Applies to:");
    for (const record of appliesTo) {
      lines.push(`- ${stableRecordKey(record)} (${record.declaredLicense})`);
    }
    lines.push("");
    lines.push(`Representative file: ${stableRecordKey(group.representative)}/${group.representative.licenseFile}`);
    lines.push("");
    lines.push(group.text);
    lines.push("");
  }

  const output = `${lines.join("\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;

  if (check) {
    // Git may check this committed text file out with CRLF on Windows. The
    // generated artifact is canonical LF, so compare content rather than the
    // host checkout's line-ending convention.
    const current = existsSync(outputPath)
      ? normalizeLineEndings(readFileSync(outputPath, "utf8"))
      : "";
    if (current !== output) {
      console.error(
        "THIRD_PARTY_LICENSES is out of date. Run `pnpm licenses:generate` and commit the result.",
      );
      process.exit(1);
    }
    console.log("third-party license notice check passed");
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output);
    console.log(`wrote ${relative(repoRoot, outputPath)} (${records.length} packages)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof StaleInstallError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
