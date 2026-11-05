// Oracle: the shared stager (`scripts/stage-runtime.mjs`, the code that
// verifies the bundled runtime at packaging) must reach the same verdict as
// main's async verifier on any payload. Mutations cover what the release
// sealing defends against; resealed variants move each one past the
// inventory hash so the later checks are the ones deciding.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { seal, sha256, writePayload } from "./test-fixture";
import { verifyManagedRuntime, type RuntimePin } from "./verify-runtime";

type OraclePin = { manifest: { version: string; source_revision: string }; asset: { inventory_sha256: string }; key: string };
type Oracle = { verifyRuntime: (root: string, pin: OraclePin, options: { requireSigned?: boolean; probe?: boolean }) => unknown };

const STAGER = join(__dirname, "..", "..", "..", "..", "scripts", "stage-runtime.mjs");
const VERSION = "2.56.0-dev-pwrgit.7";
let oracle: Oracle;
let scratch: string;
let pristine: string;
let pristinePin: RuntimePin;

beforeAll(async () => {
  oracle = (await import(/* @vite-ignore */ pathToFileURL(STAGER).href)) as Oracle;
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-managed-oracle-")));
  pristine = join(scratch, "pristine");
  pristinePin = writePayload(pristine, { version: VERSION, key: "linux-x64" });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const toOracle = (pin: RuntimePin): OraclePin => ({
  manifest: { version: pin.version, source_revision: pin.sourceRevision },
  asset: { inventory_sha256: pin.asset.inventory_sha256 },
  key: pin.key
});

const FILES = ["bin/git", "bin/git-lfs", "libexec/git-core/git-remote-https", "share/git-core/templates/hooks/README", "etc/gitconfig", "ssl/cacert.pem"];

const MUTATIONS = [
  "none",
  "flip-byte",
  "mode-bit",
  "extra-file",
  "missing-file",
  "escaping-symlink",
  "absolute-symlink",
  "broken-symlink",
  "retarget-internal-symlink",
  "build-version",
  "build-revision",
  "build-sha1",
  "inventory-hash",
  "build-architecture"
] as const;
type Mutation = (typeof MUTATIONS)[number];

function mutate(root: string, mutation: Mutation, file: string): void {
  const path = join(root, file);
  const build = (patch: Record<string, unknown>): void => {
    const record = JSON.parse(readFileSync(join(root, "pwrgit-build.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(root, "pwrgit-build.json"), JSON.stringify({ ...record, ...patch }));
  };
  switch (mutation) {
    case "none":
    case "inventory-hash":
      return;
    case "flip-byte": {
      const bytes = readFileSync(path);
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      writeFileSync(path, bytes);
      return;
    }
    case "mode-bit":
      chmodSync(path, 0o777);
      return;
    case "extra-file":
      writeFileSync(join(root, "libexec", "git-core", "git-planted"), "#!/bin/sh\n");
      return;
    case "missing-file":
      unlinkSync(path);
      return;
    case "escaping-symlink":
      symlinkSync("../../../outside", join(root, "libexec", "git-core", "git-escape"));
      writeFileSync(join(root, "..", "outside"), "outside\n");
      return;
    case "absolute-symlink":
      symlinkSync("/bin/sh", join(root, "libexec", "git-core", "git-absolute"));
      return;
    case "broken-symlink":
      symlinkSync("does-not-exist", join(root, "libexec", "git-core", "git-broken"));
      return;
    case "retarget-internal-symlink":
      unlinkSync(join(root, "libexec", "git-core", "git"));
      symlinkSync("../../bin/git-lfs", join(root, "libexec", "git-core", "git"));
      return;
    case "build-version":
      build({ version: "2.56.0-dev-pwrgit.8" });
      return;
    case "build-revision":
      build({ source_revision: "b".repeat(40) });
      return;
    case "build-sha1":
      build({ primary_sha1: "OPENSSL" });
      return;
    case "build-architecture":
      build({ architecture: "arm64" });
      return;
  }
}

async function verdicts(mutation: Mutation, file: string, reseal: boolean, run: number) {
  const root = join(scratch, `case-${run}`, "runtime");
  rmSync(join(scratch, `case-${run}`), { recursive: true, force: true });
  cpSync(pristine, root, { recursive: true, verbatimSymlinks: true });
  mutate(root, mutation, file);
  let pin = pristinePin;
  if (reseal) pin = seal(root, { version: VERSION, key: "linux-x64" });
  if (mutation === "inventory-hash") pin = { ...pin, asset: { ...pin.asset, inventory_sha256: "0".repeat(64) } };
  let stager: string | null = null;
  try {
    oracle.verifyRuntime(root, toOracle(pin), { requireSigned: false, probe: false });
  } catch (error) {
    stager = error instanceof Error ? error.message : String(error);
  }
  let managed: string | null = null;
  try {
    await verifyManagedRuntime(root, pin, { requireSigned: false, probe: false });
  } catch (error) {
    managed = error instanceof Error ? error.message : String(error);
  }
  rmSync(join(scratch, `case-${run}`), { recursive: true, force: true });
  return { stager, managed };
}

describe("verifyManagedRuntime agrees with the shared stager", () => {
  test("an untouched payload passes both", async () => {
    expect(await verdicts("none", "bin/git", false, 0)).toEqual({ stager: null, managed: null });
  });

  test("any mutation is refused by both, or by neither", async () => {
    let run = 1;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...MUTATIONS),
        fc.constantFrom(...FILES),
        fc.boolean(),
        async (mutation, file, reseal) => {
          const { stager, managed } = await verdicts(mutation, file, reseal, run++);
          if (mutation === "build-architecture" && reseal) {
            // The one deliberate difference: the stager trusts the asset key
            // for Linux; a download also refuses a build record for another CPU.
            expect(stager).toBeNull();
            expect(managed).toMatch(/built for arm64, not linux-x64/);
            return;
          }
          expect(managed === null).toBe(stager === null);
          // Where both refuse with a stager sentence, it is the same sentence.
          if (stager !== null && managed !== null && !/ENOENT|no such file/.test(stager)) {
            expect(managed).toBe(stager);
          }
        }
      ),
      { numRuns: 120 }
    );
  });

  // Shrunk cases worth naming.
  test.each([
    ["escaping-symlink", true],
    ["retarget-internal-symlink", true],
    ["build-revision", true],
    ["extra-file", false],
    ["mode-bit", true]
  ] as const)("%s (resealed: %s) is refused by both", async (mutation, reseal) => {
    const { stager, managed } = await verdicts(mutation, "bin/git", reseal, 10_000 + MUTATIONS.indexOf(mutation));
    if (mutation === "mode-bit" || mutation === "retarget-internal-symlink") {
      // Resealed, a changed mode or link is a different but self-consistent
      // payload: both accept it; only the catalog's inventory hash refuses it.
      expect({ stager, managed }).toEqual({ stager: null, managed: null });
      return;
    }
    expect(stager).not.toBeNull();
    expect(managed).not.toBeNull();
  });
});

// The release's own signed macOS payload, when it is on this machine:
// PWRGIT_MANAGED_GIT_ARCHIVE=<pwrgit-…-darwin-universal.tar.gz>
// PWRGIT_MANAGED_GIT_PIN=<its runtime-manifest.json>. Both verifiers must
// accept it with signatures and the probe on, and both must refuse it after
// one Mach-O byte changes and the inventory is resealed around the change,
// which leaves the signature check as the only thing standing.
const archivePath = process.env["PWRGIT_MANAGED_GIT_ARCHIVE"];
const pinPath = process.env["PWRGIT_MANAGED_GIT_PIN"];
describe.skipIf(process.platform !== "darwin" || archivePath === undefined || pinPath === undefined)("the signed release payload", () => {
  test("passes both, and a resealed one-byte change fails both on its signature", async () => {
    const catalog = JSON.parse(readFileSync(pinPath as string, "utf8")) as {
      version: string;
      source_revision: string;
      assets: Record<string, { sha256: string; inventory_sha256: string; url: string }>;
    };
    const asset = catalog.assets["darwin-universal"] as { sha256: string; inventory_sha256: string; url: string };
    expect(sha256(readFileSync(archivePath as string))).toBe(asset.sha256);
    const root = join(scratch, "signed", "runtime");
    execFileSync("mkdir", ["-p", root]);
    execFileSync("tar", ["-xzf", archivePath as string, "-C", root]);
    const pin: RuntimePin = { version: catalog.version, sourceRevision: catalog.source_revision, key: "darwin-universal", asset };
    expect(() => oracle.verifyRuntime(root, toOracle(pin), {})).not.toThrow();
    await expect(verifyManagedRuntime(root, pin)).resolves.toMatchObject({ version: catalog.version, architecture: "universal" });

    const target = join(root, "libexec", "git-core", "git-remote-http");
    const bytes = readFileSync(target);
    // Inside the first slice's code pages, which its signature hashes.
    const at = Math.floor(bytes.length / 4);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    unlinkSync(target);
    writeFileSync(target, bytes);
    chmodSync(target, 0o755);
    const inventory = JSON.parse(readFileSync(join(root, "runtime-files.json"), "utf8")) as Record<string, { sha256: string }>;
    (inventory["libexec/git-core/git-remote-http"] as { sha256: string }).sha256 = sha256(bytes);
    writeFileSync(join(root, "runtime-files.json"), JSON.stringify(inventory));
    const resealed = { ...pin, asset: { ...asset, inventory_sha256: sha256(readFileSync(join(root, "runtime-files.json"))) } };
    expect(() => oracle.verifyRuntime(root, toOracle(resealed), {})).toThrow(/codesign failed/);
    await expect(verifyManagedRuntime(root, resealed)).rejects.toThrow(/git-remote-http isn’t signed by PwrDrvr/);
  }, 120_000);
});
