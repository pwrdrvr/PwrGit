import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = resolve(repoRoot, "packages", "pwrgit");

const EXPECTED_DESCRIPTION =
  "Reserved npm name for the PwrGit desktop app; contains no executable code";
const EXPECTED_DECLARED_FILES = ["LICENSE", "README.md"];
const EXPECTED_PACKED_FILES = ["LICENSE", "README.md", "package.json"];
const FORBIDDEN_MANIFEST_FIELDS = [
  "bin",
  "browser",
  "bundleDependencies",
  "bundledDependencies",
  "dependencies",
  "devDependencies",
  "exports",
  "main",
  "module",
  "optionalDependencies",
  "peerDependencies",
  "scripts",
  "types",
  "typings",
];

function sorted(values) {
  return [...values].sort();
}

export function checkReservationManifest(manifest, readme) {
  const failures = [];

  if (manifest.name !== "pwrgit") {
    failures.push('package name must be "pwrgit"');
  }
  if (!/^0\.0\.[1-9]\d*$/.test(manifest.version ?? "")) {
    failures.push(
      "package version must be a nonzero 0.0.x reservation version, independent of the desktop release",
    );
  }
  if (manifest.private !== false) {
    failures.push(
      'package must declare "private": false so corrected reservation metadata can be published',
    );
  }
  if (manifest.description !== EXPECTED_DESCRIPTION) {
    failures.push(`package description must be ${JSON.stringify(EXPECTED_DESCRIPTION)}`);
  }
  if (manifest.homepage !== "https://pwrgit.com") {
    failures.push('package homepage must be "https://pwrgit.com"');
  }
  if (manifest.publishConfig?.access !== "public") {
    failures.push('package publishConfig.access must be "public"');
  }

  const declaredFiles = Array.isArray(manifest.files) ? sorted(manifest.files) : [];
  if (
    JSON.stringify(declaredFiles) !== JSON.stringify(EXPECTED_DECLARED_FILES)
  ) {
    failures.push(
      `package files must contain only ${EXPECTED_DECLARED_FILES.map(JSON.stringify).join(", ")}`,
    );
  }

  for (const field of FORBIDDEN_MANIFEST_FIELDS) {
    if (Object.hasOwn(manifest, field)) {
      failures.push(`package must not declare ${JSON.stringify(field)}`);
    }
  }

  for (const [description, pattern] of [
    ["state that it only reserves the npm name", /only reserves the npm package name/i],
    ["state that it does not contain the desktop app", /does not contain the\s+PwrGit application/i],
    ["state that npm install does not install PwrGit", /npm install pwrgit[^\n]*does not install PwrGit/i],
    ["link to the product download site", /https:\/\/pwrgit\.com/i],
  ]) {
    if (!pattern.test(readme)) {
      failures.push(`README must ${description}`);
    }
  }

  return failures.sort((a, b) => a.localeCompare(b));
}

export function checkPackedFiles(files) {
  const packedFiles = sorted(files);
  if (JSON.stringify(packedFiles) === JSON.stringify(EXPECTED_PACKED_FILES)) {
    return [];
  }
  return [
    `packed tarball must contain only ${EXPECTED_PACKED_FILES.join(", ")}; found ${packedFiles.join(", ") || "nothing"}`,
  ];
}

export function readPackedFiles(dir = packageDir) {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: dir,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );

  if (result.error) {
    throw new Error(`failed to run npm pack: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm pack failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error.message}`);
  }

  if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0].files)) {
    throw new Error("npm pack returned an unexpected report");
  }
  return report[0].files.map((file) => file.path);
}

export function checkReservationPackage(dir = packageDir) {
  const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  const readme = readFileSync(resolve(dir, "README.md"), "utf8");
  return [
    ...checkReservationManifest(manifest, readme),
    ...checkPackedFiles(readPackedFiles(dir)),
  ].sort((a, b) => a.localeCompare(b));
}

function runCli() {
  let failures;
  try {
    failures = checkReservationPackage();
  } catch (error) {
    console.error(`pwrgit reservation package check failed: ${error.message}`);
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error("pwrgit reservation package check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("pwrgit reservation package check passed");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
