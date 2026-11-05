// The managed-runtime half of the shared stager's contract.
//
// `apps/desktop/scripts/stage-runtime.mjs` (shared with PwrAgent, pinned by
// its `consumer_sha256`) verifies the bundled runtime at packaging time with
// `spawnSync`. Main cannot block on twelve `codesign` runs, so this is the
// same check, async: same inventory, file set, modes, internal symlinks,
// build record, universal slices, team signature and executable probe, in
// the same order. `verify-runtime.oracle.test.ts` runs both on the same
// mutated payloads and requires the same verdict; change them together.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const PWRDRVR_TEAM_ID = "T44CNHC4UH";
export const PWRDRVR_SIGNING = `Developer ID Application: PwrDrvr LLC (${PWRDRVR_TEAM_ID})`;
const TEAM_REQUIREMENT = `=anchor apple generic and certificate leaf[subject.OU] = "${PWRDRVR_TEAM_ID}"`;
const MACH_O_MAGIC = new Set(["cffaedfe", "feedfacf", "cafebabe", "bebafeca"]);

/** One platform's entry in a runtime catalog (`runtime-manifest.json`). */
export type RuntimeAsset = {
  sha256: string;
  inventory_sha256: string;
  url: string;
  team_id?: string;
  notarized?: boolean;
  signing?: string;
  /** Linux: the catalog's `ca_bundle.sha256`, the bytes of `ssl/cacert.pem`
   *  that `GIT_SSL_CAINFO` points HTTPS at. */
  ca_bundle_sha256?: string;
};

/** A catalog entry already accepted by `catalog.ts`: the version and source
 *  the payload must declare, and the platform key it was built for. */
export type RuntimePin = {
  version: string;
  sourceRevision: string;
  key: "darwin-universal" | "linux-x64" | "linux-arm64";
  asset: RuntimeAsset;
};

/** What the payload's `pwrgit-build.json` says, once it matched the pin. */
export type VerifiedRuntime = {
  version: string;
  sourceRevision: string;
  lfsVersion: string | null;
  architecture: string;
  executables: number;
};

export type CommandResult = { ok: boolean; stdout: string; stderr: string };
export type RunCommand = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export type VerifyOptions = {
  /** Check Developer ID signatures (macOS). The oracle test turns it off for
   *  synthetic payloads, as the stager's `requireSigned: false` does. */
  requireSigned?: boolean;
  /** Run the payload's own Git (`--build-options`, `--version`, LFS). */
  probe?: boolean;
  run?: RunCommand;
  /** Concurrent signature checks. */
  concurrency?: number;
};

/** Why a payload was refused: the same sentences the stager throws, so a log
 *  from either names the same failure. */
export class RuntimeVerificationError extends Error {
  constructor(message: string, readonly kind: "inventory" | "files" | "build" | "signature" | "probe") {
    super(message);
    this.name = "RuntimeVerificationError";
  }
}

const defaultRun: RunCommand = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 120_000, windowsHide: true, env: options.env }, (error, stdout, stderr) =>
      resolve({ ok: error === null, stdout: String(stdout).trim(), stderr: String(stderr).trim() })
    );
  });

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function startsWithMachO(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGIC.has(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

type Entry = { sha256?: string; mode?: number; link?: string };

async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Verify an extracted runtime directory against its pin. Throws a
 * `RuntimeVerificationError` naming the first difference; nothing is
 * written, so a refused payload is exactly as it was unpacked.
 */
export async function verifyManagedRuntime(
  directory: string,
  pin: RuntimePin,
  options: VerifyOptions = {}
): Promise<VerifiedRuntime> {
  const requireSigned = options.requireSigned ?? true;
  const run = options.run ?? defaultRun;
  const root = await realpath(directory);
  const inventoryBytes = await readFile(join(root, "runtime-files.json"));
  if (createHash("sha256").update(inventoryBytes).digest("hex") !== pin.asset.inventory_sha256) {
    throw new RuntimeVerificationError("Git inventory checksum mismatch", "inventory");
  }
  const expected = JSON.parse(inventoryBytes.toString("utf8")) as Record<string, Entry>;
  const actual: Record<string, Entry> = {};
  const executables: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      if (rel === "runtime-files.json") continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(path);
        } catch {
          throw new RuntimeVerificationError(`Git symlink escapes payload: ${rel}`, "files");
        }
        const resolved = relative(root, target);
        if (resolved === ".." || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
          throw new RuntimeVerificationError(`Git symlink escapes payload: ${rel}`, "files");
        }
        actual[rel] = { link: await readlink(path) };
      } else if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile()) {
        actual[rel] = { sha256: await sha256File(path), mode: stat.mode & 0o7777 };
        if (await startsWithMachO(path)) executables.push(path);
      } else {
        throw new RuntimeVerificationError(`Unexpected Git payload file: ${rel}`, "files");
      }
    }
  };
  await visit(root);
  for (const [name, entry] of Object.entries(expected)) {
    const found = actual[name];
    if (found === undefined || found.link !== entry.link || found.sha256 !== entry.sha256 || found.mode !== entry.mode) {
      throw new RuntimeVerificationError(`Packaged custom Git bytes, mode or link changed: ${name}`, "files");
    }
  }
  if (Object.keys(actual).length !== Object.keys(expected).length) {
    throw new RuntimeVerificationError("Custom Git file set changed", "files");
  }
  const build = JSON.parse(await readFile(join(root, "pwrgit-build.json"), "utf8")) as Record<string, unknown>;
  if (build["version"] !== pin.version || build["source_revision"] !== pin.sourceRevision || build["primary_sha1"] !== "SHA1_DC") {
    throw new RuntimeVerificationError("Custom Git source/version mismatch", "build");
  }
  // The stager trusts the asset key for Linux (the inventory pins that key's
  // bytes); a managed install also refuses a record for another CPU, so a
  // catalog that pointed one key at another's archive cannot pass.
  if (pin.key !== "darwin-universal" && build["architecture"] !== pin.key.slice("linux-".length)) {
    throw new RuntimeVerificationError(`Custom Git was built for ${String(build["architecture"])}, not ${pin.key}`, "build");
  }
  // Linux HTTPS trusts exactly this file (`bundledGitEnvironment` sets
  // GIT_SSL_CAINFO to it), so it must be the bundle the catalog names.
  if (pin.asset.ca_bundle_sha256 !== undefined && expected["ssl/cacert.pem"]?.sha256 !== pin.asset.ca_bundle_sha256) {
    throw new RuntimeVerificationError("Custom Git CA bundle doesn’t match its release", "files");
  }
  if (pin.key === "darwin-universal") {
    if (build["architecture"] !== "universal" || executables.length === 0) {
      throw new RuntimeVerificationError("Expected universal Git executables", "build");
    }
    if (requireSigned && (build["notarized"] !== true || build["signing"] !== PWRDRVR_SIGNING)) {
      throw new RuntimeVerificationError("Expected Developer ID signed and notarized custom Git", "build");
    }
    await mapLimit(executables, options.concurrency ?? 4, async (file) => {
      const archs = await run("/usr/bin/lipo", ["-archs", file]);
      if (!archs.ok || archs.stdout.split(/\s+/).sort().join(" ") !== "arm64 x86_64") {
        throw new RuntimeVerificationError(`Missing universal Git slice: ${relative(root, file)}`, "signature");
      }
      const signed = await run("/usr/bin/codesign", [
        "--verify", "--all-architectures", "--strict",
        ...(requireSigned ? ["--test-requirement", TEAM_REQUIREMENT] : []),
        file
      ]);
      if (!signed.ok) {
        throw new RuntimeVerificationError(
          `${relative(root, file)} isn’t signed by PwrDrvr (team ${PWRDRVR_TEAM_ID}): ${signed.stderr || "codesign refused it"}`,
          "signature"
        );
      }
    });
  }
  const lfsVersion = typeof build["lfs_version"] === "string" ? build["lfs_version"] : null;
  if (options.probe ?? true) await probeManagedRuntime(root, pin, { lfsVersion, run });
  return {
    version: pin.version,
    sourceRevision: pin.sourceRevision,
    lfsVersion,
    architecture: String(build["architecture"]),
    executables: executables.length
  };
}

/**
 * Run the payload's own Git the way the stager does: its build options name
 * the pinned commit and SHA1DC, `--version` is the pinned version, its exec
 * path is inside the payload (relocation works), and its Git LFS answers.
 */
export async function probeManagedRuntime(
  directory: string,
  pin: RuntimePin,
  options: { lfsVersion?: string | null; run?: RunCommand } = {}
): Promise<void> {
  const run = options.run ?? defaultRun;
  const root = await realpath(directory);
  const lfsVersion =
    options.lfsVersion !== undefined
      ? options.lfsVersion
      : ((JSON.parse(await readFile(join(root, "pwrgit-build.json"), "utf8")) as Record<string, unknown>)["lfs_version"] as string | undefined) ?? null;
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GIT_|DYLD_|LD_)/.test(name))
  );
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["PATH"] = `${join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const git = join(root, "bin", "git");
  const answer = async (args: string[]): Promise<string> => {
    const result = await run(git, args, { env });
    if (!result.ok) throw new RuntimeVerificationError(`git ${args.join(" ")} failed: ${result.stderr}`, "probe");
    return result.stdout;
  };
  const buildOptions = (await answer(["version", "--build-options"])).split(/\r?\n/);
  if (!buildOptions.includes("SHA-1: SHA1_DC") || !buildOptions.includes(`built from commit: ${pin.sourceRevision}`)) {
    throw new RuntimeVerificationError("Executable Git source revision or primary SHA1_DC protection changed", "probe");
  }
  if (
    (await answer(["--version"])) !== `git version ${pin.version}` ||
    (await answer(["--exec-path"])) !== join(root, "libexec", "git-core") ||
    !(await answer(["lfs", "version"])).startsWith(`git-lfs/${String(lfsVersion)} `)
  ) {
    throw new RuntimeVerificationError("Packaged custom Git, LFS or relocated helper resolution failed", "probe");
  }
}
