import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readRuntimeManifest, stageRuntime, verifyRuntime } from "./stage-runtime.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const consumer = sha(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "stage-runtime.mjs")));
const VERSION = "2.56.0-dev-pwrgit.9";
const REVISION = "a".repeat(40);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-stage-runtime-")));
  roots.push(root);
  return root;
}

function manifest(overrides = {}, asset = {}) {
  return {
    schema: 1,
    consumer_sha256: consumer,
    source_revision: REVISION,
    version: VERSION,
    assets: {
      "linux-x64": {
        sha256: "1".repeat(64),
        inventory_sha256: "2".repeat(64),
        url: `https://github.com/huntharo/git/releases/download/v${VERSION}/fixture-linux-x64.tar.gz`,
        ...asset,
      },
    },
    ...overrides,
  };
}

function writeManifest(value) {
  const path = join(scratch(), "custom-git-runtime.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** A runtime tree with its sealed inventory, and the pin that approves it. */
function runtime() {
  const root = scratch();
  const file = (rel, body, mode = 0o644) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
    chmodSync(join(root, rel), mode);
  };
  file("bin/git", "#!/bin/sh\n", 0o755);
  file("COPYING", "GPL-2.0 fixture\n");
  file("pwrgit-build.json", JSON.stringify({ version: VERSION, source_revision: REVISION, primary_sha1: "SHA1_DC" }));
  mkdirSync(join(root, "libexec", "git-core"), { recursive: true });
  symlinkSync("../../bin/git", join(root, "libexec", "git-core", "git"));
  const inventory = {};
  for (const rel of ["COPYING", "bin/git", "pwrgit-build.json"]) {
    const bytes = readFileSync(join(root, rel));
    inventory[rel] = { sha256: sha(bytes), mode: rel === "bin/git" ? 0o755 : 0o644 };
  }
  inventory["libexec/git-core/git"] = { link: "../../bin/git" };
  const inventoryBytes = JSON.stringify(inventory);
  writeFileSync(join(root, "runtime-files.json"), inventoryBytes);
  const pin = {
    key: "linux-x64",
    manifest: { version: VERSION, source_revision: REVISION },
    asset: { inventory_sha256: sha(inventoryBytes) },
  };
  return { root, pin };
}

const offline = { requireSigned: false, probe: false };

describe("readRuntimeManifest", () => {
  test("accepts a pinned manifest and selects the platform asset", () => {
    const pin = readRuntimeManifest(writeManifest(manifest()), "linux", "x64");
    expect(pin.key).toBe("linux-x64");
    expect(pin.asset.sha256).toBe("1".repeat(64));
  });

  test("refuses a manifest approved for a different consumer implementation", () => {
    expect(() => readRuntimeManifest(writeManifest(manifest({ consumer_sha256: "0".repeat(64) })), "linux", "x64"))
      .toThrow("Custom Git consumer differs");
  });

  test("refuses a missing asset, a moving URL, and a query string", () => {
    expect(() => readRuntimeManifest(writeManifest(manifest()), "linux", "arm64")).toThrow("incomplete custom Git manifest");
    const latest = manifest({}, { url: "https://github.com/huntharo/git/releases/latest/download/git.tar.gz" });
    expect(() => readRuntimeManifest(writeManifest(latest), "linux", "x64")).toThrow("immutable versioned release URL");
    const query = manifest({}, { url: `https://github.com/huntharo/git/releases/download/v${VERSION}/git.tar.gz?x=1` });
    expect(() => readRuntimeManifest(writeManifest(query), "linux", "x64")).toThrow("immutable versioned release URL");
  });

  test("requires the notarized PwrDrvr payload on macOS", () => {
    const value = manifest();
    value.assets["darwin-universal"] = { ...value.assets["linux-x64"], notarized: false, team_id: "T44CNHC4UH" };
    expect(() => readRuntimeManifest(writeManifest(value), "darwin", "arm64")).toThrow("approved notarized PwrDrvr payload");
  });
});

describe.skipIf(process.platform === "win32")("verifyRuntime", () => {
  test("accepts the sealed tree it was pinned to", () => {
    const { root, pin } = runtime();
    expect(verifyRuntime(root, pin, offline).version).toBe(VERSION);
  });

  test("refuses an inventory other than the pinned one", () => {
    const { root, pin } = runtime();
    expect(() => verifyRuntime(root, { ...pin, asset: { inventory_sha256: "0".repeat(64) } }, offline))
      .toThrow("Git inventory checksum mismatch");
  });

  test("refuses changed bytes and a changed mode", () => {
    const changed = runtime();
    writeFileSync(join(changed.root, "COPYING"), "tampered\n");
    expect(() => verifyRuntime(changed.root, changed.pin, offline)).toThrow("bytes, mode or link changed: COPYING");
    const mode = runtime();
    chmodSync(join(mode.root, "bin", "git"), 0o777);
    expect(() => verifyRuntime(mode.root, mode.pin, offline)).toThrow("bytes, mode or link changed: bin/git");
  });

  test("refuses a file the inventory does not list", () => {
    const { root, pin } = runtime();
    writeFileSync(join(root, "bin", "extra"), "injected\n");
    expect(() => verifyRuntime(root, pin, offline)).toThrow("Custom Git file set changed");
  });

  test("refuses a symlink that leaves the payload", () => {
    const { root, pin } = runtime();
    symlinkSync(tmpdir(), join(root, "bin", "outside"));
    expect(() => verifyRuntime(root, pin, offline)).toThrow("Git symlink escapes payload: bin/outside");
  });

  test("refuses a build that names another source revision", () => {
    const { root, pin } = runtime();
    expect(() => verifyRuntime(root, { ...pin, manifest: { ...pin.manifest, source_revision: "b".repeat(40) } }, offline))
      .toThrow("Custom Git source/version mismatch");
  });
});

describe.skipIf(process.platform === "win32")("stageRuntime", () => {
  // A strict umask must not change the sealed modes: plain `tar -xzf` applies
  // it and the inventory check then refuses the runtime (huntharo/git#33).
  test("stages a cached archive under umask 077 with its sealed modes intact", async () => {
    const temp = scratch();
    const root = join(temp, "runtime");
    mkdirSync(join(root, "bin"), { recursive: true });
    const metadata = join(root, "pwrgit-build.json");
    writeFileSync(metadata, JSON.stringify({ version: VERSION, source_revision: REVISION, primary_sha1: "SHA1_DC", lfs_version: "3.7.1" }));
    chmodSync(metadata, 0o644);
    const git = join(root, "bin", "git");
    writeFileSync(git, `#!/bin/sh
case "$*" in
  '--version') echo 'git version ${VERSION}' ;;
  'version --build-options') printf '%s\\n' 'SHA-1: SHA1_DC' 'built from commit: ${REVISION}' ;;
  '--exec-path') printf '%s/libexec/git-core\\n' "\${0%/bin/git}" ;;
  'lfs version') echo 'git-lfs/3.7.1 test' ;;
  *) exit 1 ;;
esac
`);
    chmodSync(git, 0o755);
    const inventory = JSON.stringify({
      "bin/git": { sha256: sha(readFileSync(git)), mode: 0o755 },
      "pwrgit-build.json": { sha256: sha(readFileSync(metadata)), mode: 0o644 },
    });
    writeFileSync(join(root, "runtime-files.json"), inventory);
    const cache = join(temp, "cache");
    mkdirSync(cache);
    const archive = join(temp, "fixture.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", root, "."]);
    const digest = sha(readFileSync(archive));
    renameSync(archive, join(cache, `${digest}.tar.gz`));
    const manifestPath = writeManifest(manifest({}, { sha256: digest, inventory_sha256: sha(inventory) }));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("expected the cached archive"));
    const output = join(temp, "staged");
    const previous = process.umask(0o077);
    try {
      await stageRuntime({ manifestPath, platform: "linux", arch: "x64", output, cache });
    } finally {
      process.umask(previous);
      fetch.mockRestore();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(statSync(join(output, "pwrgit-build.json")).mode & 0o777).toBe(0o644);
    expect(statSync(join(output, "bin", "git")).mode & 0o777).toBe(0o755);
  });
});
