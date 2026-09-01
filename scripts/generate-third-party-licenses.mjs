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

import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(repoRoot, "THIRD_PARTY_LICENSES");
/**
 * The workspace projects whose shipped dependencies this notice covers.
 *
 * Names only. These are read verbatim into the notice's Scope prose; the pnpm
 * selector below is what actually chooses packages.
 */
export const SHIPPED_PACKAGE_NAMES = ["@pwrgit/desktop", "@pwrgit/mcp-server"];

/**
 * The `--filter` values every `pnpm licenses list` invocation here is run with.
 *
 * The trailing `...` is load-bearing, and is the whole reason this is a named
 * constant rather than an inline array. A bare `--filter @pwrgit/desktop`
 * selects that one project, so pnpm reports only what
 * `apps/desktop/package.json` declares itself — everything reached *through* a
 * workspace dependency is invisible. Those packages still ship in the packaged
 * app, and because the allowlist gate reads this same selector, they would
 * never be judged against the allowed-license list either: a GPL dependency
 * arriving under one of them ships with green CI and no new heading in the
 * notice diff, which is the exact failure the gate exists to prevent.
 * `<project>...` selects the project plus its dependency projects, which is
 * the set that actually ships.
 *
 * PwrGit's own workspace dependencies (`@pwrgit/shared`, and `@pwrgit/mcp-server`
 * which is selected explicitly anyway) declare no npm dependencies today, so
 * the suffix adds nothing to the current notice. That is precisely why a test
 * pins these strings: dropping it is a one-character edit that leaves every
 * other check in `licenses:check` passing.
 */
export const NOTICE_PNPM_FILTERS = SHIPPED_PACKAGE_NAMES.map(
  (name) => `${name}...`,
);
const embeddedGitNoticeDir = join(
  repoRoot,
  "apps",
  "desktop",
  "resources",
  "embedded-git",
);

/**
 * The two `pnpm licenses list` invocations the notice is built from.
 *
 * Exported so `check-third-party-license-allowlist.mjs` reads exactly the
 * surfaces the notice discloses. A gate whose input set is narrower than the
 * notice's contents leaves a shipped component ungated while still printing a
 * pass.
 */
export const NOTICE_PNPM_ARGS = {
  // Optional dependencies are platform-specific. Excluding them keeps this
  // committed notice deterministic across macOS, Linux, and Windows CI — and
  // means an optional dependency that ships is disclosed by neither the notice
  // nor the gate until someone lists it here deliberately.
  production: ["--prod", "--no-optional"],
  all: ["--no-optional"],
};

/**
 * devDependencies the notice covers anyway, because they ship.
 *
 * Electron is the whole list today: `--prod` never reports it, so the notice
 * merges it in from the `all` report below. The allowlist gate reads this same
 * set — a name disclosed here but missing there would be the single largest
 * shipped component with an unchecked license.
 */
export const NOTICE_DEV_DEPENDENCIES = new Set(["electron"]);

/**
 * Matches GPL, AGPL and LGPL identifiers inside an SPDX expression.
 *
 * `[^A-Za-z]` rather than `\b` because the letter before "GPL" is exactly what
 * distinguishes LGPL/AGPL from a word boundary.
 */
export const COPYLEFT_PATTERN = /(^|[^A-Za-z])[AL]?GPL/i;

/**
 * True when a declared license names a GPL-family identifier.
 *
 * Shared with the allowlist gate so the two agree on what needs disclosure:
 * the gate refuses a copyleft embedded runtime with no `copyleft` descriptor,
 * and `validateEmbeddedNoticeSource` below refuses to generate a notice for
 * one. Same rule, both directions.
 */
export function declaresCopyleft(declaredLicense) {
  return COPYLEFT_PATTERN.test(declaredLicense);
}

// Dugite downloads and ships this runtime outside npm's package inventory.
// Keep the versions and source URLs in sync with its embedded-git.json when
// updating the dugite dependency.
export const EMBEDDED_GIT_NOTICE_SOURCES = [
  {
    name: "Git embedded runtime",
    version: "2.53.0",
    declaredLicense: "GPL-2.0-only",
    file: "COPYING",
    source: "https://github.com/desktop/dugite-native/tree/v2.53.0-4",
    // The one strong-copyleft component PwrGit ships, and the only entry the
    // allowlist gate lets GPL-2.0-only through for. Git is invoked as a
    // separate executable over a process boundary — PwrGit links nothing from
    // it — so PwrGit itself is not a derivative work. Distributing the binary
    // still carries GPL-2.0 section 3, which is what this descriptor records:
    // where the source for what ships is published. The build scripts and
    // patches are `source` above, not repeated here — one URL, one place to
    // update on a Dugite bump.
    copyleft: {
      correspondingSource: "https://github.com/git/git/tree/v2.53.0",
    },
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

/**
 * A `pnpm licenses list` invocation that failed, carrying pnpm's own exit code.
 *
 * Thrown rather than exiting, because this module is imported by two CLIs and
 * by their tests. Terminating the process from inside an exported function
 * would take a vitest worker down with it and leave no failing assertion to
 * point at. Each CLI turns this back into an exit, below.
 */
export class PnpmLicensesError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PnpmLicensesError";
    this.status = status;
  }
}

/**
 * Run `pnpm licenses list` and parse its JSON.
 */
export function runPnpmLicenses(args) {
  const result = spawnSync(
    "pnpm",
    [
      "licenses",
      "list",
      "--json",
      ...NOTICE_PNPM_FILTERS.flatMap((filter) => ["--filter", filter]),
      ...args,
    ],
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
    throw new PnpmLicensesError(
      `failed to run pnpm licenses: ${result.error.message}\n`,
      1,
    );
  }
  if (result.status !== 0) {
    throw new PnpmLicensesError(
      result.stderr ?? "pnpm licenses list failed\n",
      result.status ?? 1,
    );
  }
  return JSON.parse(result.stdout);
}

export function flattenLicenseReport(report) {
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

/**
 * True when an entry carries a usable corresponding-source disclosure.
 *
 * The single predicate for "does this entry have disclosure?", because three
 * places ask: this file's `validateEmbeddedNoticeSource` and Source
 * Availability section, and the allowlist gate's carve-out. When the notice
 * asked a laxer question than the other two — merely `copyleft !== undefined` —
 * a half-written descriptor slipped past the validator on a permissive entry
 * and rendered the literal string "undefined" into the committed notice.
 */
export function hasCopyleftDisclosure(notice) {
  return typeof notice.copyleft?.correspondingSource === "string";
}

/**
 * Refuse to generate a notice for a copyleft runtime with no disclosure.
 *
 * The mirror of the allowlist gate's embedded-runtime rule, enforced from the
 * generating side: a GPL entry added here without a `copyleft` descriptor would
 * otherwise be transcribed into the notice with nothing but its license text,
 * and no statement of where the corresponding source lives.
 */
export function validateEmbeddedNoticeSource(notice) {
  if (!declaresCopyleft(notice.declaredLicense)) {
    return;
  }
  if (!hasCopyleftDisclosure(notice)) {
    throw new Error(
      [
        `Embedded runtime "${notice.name}" declares ${JSON.stringify(notice.declaredLicense)},`,
        "which requires disclosure of the corresponding source. Add a `copyleft`",
        "descriptor with a `correspondingSource` URL to EMBEDDED_GIT_NOTICE_SOURCES,",
        "and confirm the license permits shipping it before doing so.",
      ].join(" "),
    );
  }
}

function readEmbeddedGitNoticeRecords() {
  return EMBEDDED_GIT_NOTICE_SOURCES.map((notice) => {
    validateEmbeddedNoticeSource(notice);
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

/**
 * Package keys (`name@version`) a notice's Dependency Summary lists.
 *
 * Parses the committed artifact rather than tracking records, because the two
 * sides of a `--check` failure are a file and a fresh generation — and when
 * they disagree it is usually the file that came from another machine.
 */
export function noticePackageKeys(notice) {
  const keys = new Set();
  for (const line of notice.split("\n")) {
    // `- name@version | source`. The Source Availability bullets above use
    // `: url` rather than ` | `, so they do not match.
    const match = /^- (.+?) \| /.exec(line);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

// Enough names to recognize the cause, few enough to stay one readable line
// when a lockfile bump moves a hundred packages at once.
const DRIFT_NAME_CAP = 20;

function formatDriftNames(keys) {
  const sorted = keys.slice().sort();
  const shown = sorted.slice(0, DRIFT_NAME_CAP);
  const hidden = sorted.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
}

/**
 * Say *what* drifted, not just that something did.
 *
 * `--check` failing with only "out of date" is unactionable when the committed
 * file and the checking machine disagree, because regenerating locally
 * reproduces neither side. Naming the packages turns that into an immediate
 * answer; when the package sets match, the drift is inside a license text or
 * the prose, so point at the first differing line instead.
 */
export function describeNoticeDrift(current, expected) {
  const currentKeys = noticePackageKeys(current);
  const expectedKeys = noticePackageKeys(expected);
  const added = Array.from(expectedKeys).filter((key) => !currentKeys.has(key));
  const removed = Array.from(currentKeys).filter((key) => !expectedKeys.has(key));

  if (added.length > 0 || removed.length > 0) {
    const parts = [];
    if (added.length > 0) {
      parts.push(`missing from the committed file: ${formatDriftNames(added)}`);
    }
    if (removed.length > 0) {
      parts.push(`no longer generated: ${formatDriftNames(removed)}`);
    }
    return parts.join("; ");
  }

  const currentLines = current.split("\n");
  const expectedLines = expected.split("\n");
  const lineCount = Math.max(currentLines.length, expectedLines.length);
  for (let index = 0; index < lineCount; index += 1) {
    if (currentLines[index] !== expectedLines[index]) {
      const show = (line) => JSON.stringify(line ?? "<end of file>");
      return [
        `same package set; first difference at line ${index + 1}:`,
        `committed ${show(currentLines[index])}`,
        `generated ${show(expectedLines[index])}`,
      ].join(" ");
    }
  }
  return "no difference found";
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
  const productionRecords = flattenLicenseReport(
    runPnpmLicenses(NOTICE_PNPM_ARGS.production),
  );
  const allRecords = flattenLicenseReport(runPnpmLicenses(NOTICE_PNPM_ARGS.all));
  const recordsByKey = new Map();

  for (const record of productionRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }

  for (const record of allRecords) {
    if (NOTICE_DEV_DEPENDENCIES.has(record.name)) {
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
    `This notice covers npm production dependencies for ${SHIPPED_PACKAGE_NAMES.join(" and ")} plus the Electron runtime package.`,
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

  // GPL-2.0 section 3 asks that a binary distribution be accompanied by the
  // corresponding source or by an offer for it. Git ships as a separate
  // executable PwrGit invokes over a process boundary, so PwrGit is not a
  // derivative work of it — but PwrGit does distribute the binary, so the
  // notice has to say where its source is.
  const copyleftNotices = EMBEDDED_GIT_NOTICE_SOURCES.filter(hasCopyleftDisclosure);
  if (copyleftNotices.length > 0) {
    lines.push("");
    lines.push("Source Availability");
    lines.push("-------------------");
    lines.push("");
    lines.push(
      "PwrGit invokes the components below as separate executables over a process boundary and links no code from them. PwrGit redistributes them as built and published upstream and applies no changes of its own. Their corresponding source, and the build scripts and patches used to produce the shipped binaries, are published at:",
    );
    for (const notice of copyleftNotices) {
      lines.push(
        `- ${notice.name} ${notice.version} (${notice.declaredLicense}): ${notice.copyleft.correspondingSource}, built by the scripts and patches at ${notice.source}`,
      );
    }
  }

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
      console.error(`Drift: ${describeNoticeDrift(current, output)}`);
      process.exit(1);
    }
    console.log("third-party license notice check passed");
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output);
    console.log(`wrote ${relative(repoRoot, outputPath)} (${records.length} packages)`);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof StaleInstallError) {
      console.error(error.message);
      process.exitCode = 1;
    } else if (error instanceof PnpmLicensesError) {
      // pnpm already wrote the useful diagnostic; pass its own status through
      // rather than burying it under a stack trace.
      process.stderr.write(error.message);
      process.exitCode = error.status;
    } else {
      throw error;
    }
  }
}
