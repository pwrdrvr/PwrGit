// Settings › Git › PwrGit's Git: check for, download, verify and install
// newer builds of PwrGit's own Git, and hand verified ones to `dugite.ts`.
//
// The lifecycle follows PwrAgent's managed Codex/Grok runtimes (one progress
// reporter, a staging directory beside the destination, an atomic rename into
// an immutable version directory, the previous build kept), with the trust
// rules of the shared stager (`catalog.ts`, `verify-runtime.ts`).
//
// Two rules the rest of the app depends on:
// - Installing never changes which Git runs. `git:selectRuntime` does, and an
//   installed Git chosen in Settings outranks any downloaded build.
// - A build is run only after it was verified in this session. The chosen
//   one is verified at launch, before any Git command starts (`holdGitUntil`).
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  compareManagedGitVersions,
  parseManagedGitVersion,
  type ManagedGitBuild,
  type ManagedGitInstallPhase,
  type ManagedGitProgress,
  type ManagedGitRelease,
  type ManagedGitStatus
} from "@pwrgit/shared";
import {
  CatalogError,
  MANAGED_GIT_RELEASES_URL,
  MAX_ARCHIVE_BYTES,
  MAX_METADATA_BYTES,
  NeedsAppUpdateError,
  acceptCatalog,
  buildId,
  eligibleReleases,
  isBuildId,
  managedPlatformKey,
  type AcceptedCatalog,
  type PlatformKey,
  type ReleaseCandidate
} from "./catalog";
import { ReleaseMetadataCache } from "./release-cache";
import { probeManagedRuntime, verifyManagedRuntime, type RuntimePin, type VerifiedRuntime, type VerifyOptions } from "./verify-runtime";

const USER_AGENT = "PwrGit-managed-git";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 250;

/** What Settings stores: the chosen build and the one chosen before it. */
export type ManagedGitSelection = { selected?: string | undefined; previous?: string | undefined };

type BuildRecord = {
  id: string;
  version: string;
  sourceRevision: string;
  key: PlatformKey;
  inventorySha256: string;
  archiveSha256: string;
  catalogSha256: string;
  trust: "signed" | "checksum";
  lfsVersion: string | null;
  installedAt: number;
  publishedAt: string | null;
};

type LastCheck = {
  checkedAt: number;
  latest: ManagedGitRelease | null;
  needsAppUpdate: string | null;
};

type StoreFile = { version: 1; builds: BuildRecord[]; lastCheck?: LastCheck };

export type ManagedGitDeps = {
  /** `<userData>/git-runtimes`. Nothing else in the app writes here. */
  root: string;
  platform: NodeJS.Platform;
  arch: string;
  /** The bundled pin (`custom-git-runtime.json`): its version is the floor,
   *  its `consumer_sha256` the stager contract a catalog must match. */
  bundled: { version: string; consumerSha256: string };
  selection: () => ManagedGitSelection;
  /** True while an installed Git chosen in Settings outranks the build. */
  installedOverride: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  verify?: (directory: string, pin: RuntimePin, options: VerifyOptions) => Promise<VerifiedRuntime>;
  probe?: (directory: string, pin: RuntimePin) => Promise<void>;
  extract?: (archive: string, destination: string, signal: AbortSignal) => Promise<void>;
  onProgress?: (progress: ManagedGitProgress) => void;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  isProcessAlive?: (pid: number) => boolean;
};

export class ManagedGitInstallError extends Error {
  constructor(message: string, readonly phase: ManagedGitInstallPhase | "checking") {
    super(message);
    this.name = "ManagedGitInstallError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runTar(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, { signal, timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      error === null ? resolve(String(stdout)) : reject(new Error(`tar could not unpack the archive: ${String(stderr).trim() || error.message}`))
    );
  });
}

/** A member name that would land outside the directory it is unpacked into. */
export function unsafeArchiveMember(name: string): boolean {
  return name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes("..");
}

/** List first, then unpack: tar's own guards differ by implementation (GNU
 *  tar strips a leading `/`, bsdtar refuses `..`), so the rule is ours. */
async function defaultExtract(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  const members = (await runTar(["-tzf", archive], signal)).split("\n").filter((name) => name !== "");
  const unsafe = members.find(unsafeArchiveMember);
  if (unsafe !== undefined) throw new Error(`The archive has an unsafe member (${unsafe}), so nothing was unpacked.`);
  await runTar(["-xzf", archive, "-C", destination], signal);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class ManagedGitService {
  readonly key: PlatformKey | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache: ReleaseMetadataCache;
  private candidates: ReleaseCandidate[] = [];
  private checkError: string | null = null;
  private progress: ManagedGitProgress | null = null;
  private running: { version: string; promise: Promise<ManagedGitStatus>; abort: AbortController } | null = null;
  private checking: Promise<ManagedGitStatus> | null = null;
  /** Builds verified in this session, by id: their payload directories. */
  private readonly verified = new Map<string, string>();
  private selectedError: string | null = null;

  constructor(private readonly deps: ManagedGitDeps) {
    this.key = managedPlatformKey(deps.platform, deps.arch);
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.cache = new ReleaseMetadataCache({ directory: deps.root, fetch: this.fetchImpl, now: this.now });
  }

  // ---------- paths and store ----------

  private versionDir(id: string): string {
    return join(this.deps.root, "versions", id);
  }

  /** The payload: `versions/<id>/<platform key>`, a whole runtime directory. */
  payloadDir(id: string): string {
    return join(this.versionDir(id), this.key ?? "unsupported");
  }

  private storeFile(): string {
    return join(this.deps.root, "builds.json");
  }

  /** Always from disk: another PwrGit (a dev build sharing the data
   *  directory) may have installed since, and a stale copy written back
   *  would drop its builds. */
  private async readStore(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storeFile(), "utf8")) as StoreFile;
      if (parsed.version === 1 && Array.isArray(parsed.builds)) {
        return {
          version: 1,
          builds: parsed.builds.filter((build) => isBuildId(build.id) && build.key === this.key),
          ...(parsed.lastCheck ? { lastCheck: parsed.lastCheck } : {})
        };
      }
    } catch {
      // No store yet, or unreadable: no builds. Their directories are
      // pruned at the next launch because nothing records them.
    }
    return { version: 1, builds: [] };
  }

  private async writeStore(store: StoreFile): Promise<void> {
    await mkdir(this.deps.root, { recursive: true });
    const temporary = join(this.deps.root, `.builds-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.storeFile());
  }

  // ---------- progress ----------

  private publish(progress: Omit<ManagedGitProgress, "updatedAt">): void {
    const event: ManagedGitProgress = { ...progress, updatedAt: this.now() };
    this.progress = progress.phase === "idle" ? null : event;
    try {
      this.deps.onProgress?.(event);
    } catch {
      // A broken subscriber must not fail an install.
    }
  }

  // ---------- status ----------

  private toBuild(record: BuildRecord): ManagedGitBuild {
    return {
      id: record.id,
      version: record.version,
      sourceRevision: record.sourceRevision,
      path: join(this.payloadDir(record.id), "bin", "git"),
      trust: record.trust,
      lfsVersion: record.lfsVersion,
      installedAt: record.installedAt,
      publishedAt: record.publishedAt
    };
  }

  async status(): Promise<ManagedGitStatus> {
    const store = await this.readStore();
    const selection = this.deps.selection();
    const builds = [...store.builds]
      .sort((a, b) => {
        const left = parseManagedGitVersion(a.version);
        const right = parseManagedGitVersion(b.version);
        return left === null || right === null ? 0 : compareManagedGitVersions(right, left);
      })
      .map((record) => this.toBuild(record));
    const selected = selection.selected !== undefined && builds.some((build) => build.id === selection.selected) ? selection.selected : null;
    return {
      supported: this.key !== null,
      bundledVersion: this.deps.bundled.version,
      latest: store.lastCheck?.latest ?? null,
      needsAppUpdate: store.lastCheck?.needsAppUpdate ?? null,
      checkedAt: store.lastCheck?.checkedAt ?? null,
      checkError: this.checkError,
      builds,
      selected,
      previous: selection.previous !== undefined && builds.some((build) => build.id === selection.previous) ? selection.previous : null,
      inUse: selected !== null && !this.deps.installedOverride() && this.selectedError === null,
      selectedError: this.selectedError,
      progress: this.progress
    };
  }

  // ---------- check ----------

  /** Ask GitHub which builds are newer than the bundle. Single-flight. */
  check(options: { force: boolean }): Promise<ManagedGitStatus> {
    if (this.key === null) return this.status();
    if (this.checking !== null) return this.checking;
    const run = this.runCheck(options.force).finally(() => {
      this.checking = null;
    });
    this.checking = run;
    return run;
  }

  private async runCheck(force: boolean): Promise<ManagedGitStatus> {
    const key = this.key as PlatformKey;
    try {
      const answer = await this.cache.get(MANAGED_GIT_RELEASES_URL, {
        force,
        headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" }
      });
      const candidates = eligibleReleases(JSON.parse(answer.body), key, this.deps.bundled.version);
      let latest: ManagedGitRelease | null = null;
      let needsAppUpdate: string | null = null;
      let firstFailure: string | null = null;
      const usable: ReleaseCandidate[] = [];
      for (const candidate of candidates) {
        try {
          await this.acceptCandidate(candidate);
          usable.push(candidate);
          latest ??= {
            version: candidate.version,
            tag: candidate.tag,
            publishedAt: candidate.publishedAt,
            size: candidate.archive.size
          };
          break;
        } catch (error) {
          if (error instanceof NeedsAppUpdateError) {
            needsAppUpdate ??= candidate.version;
            continue;
          }
          firstFailure ??= `${candidate.version}: ${errorText(error)}`;
          this.deps.log?.("warn", `managed Git ${candidate.version} skipped: ${errorText(error)}`);
        }
      }
      this.candidates = usable;
      this.checkError = latest === null && firstFailure !== null ? firstFailure : null;
      const store = await this.readStore();
      await this.writeStore({ ...store, lastCheck: { checkedAt: answer.fetchedAt, latest, needsAppUpdate } });
    } catch (error) {
      this.checkError = errorText(error);
      this.deps.log?.("warn", `managed Git check failed: ${this.checkError}`);
    }
    return this.status();
  }

  /** Download (or reuse) a release's catalog and SHA256SUMS and accept them. */
  private async acceptCandidate(candidate: ReleaseCandidate, signal?: AbortSignal): Promise<AcceptedCatalog> {
    const directory = join(this.deps.root, "catalogs", candidate.tag);
    const catalogPath = join(directory, "runtime-manifest.json");
    const sumsPath = join(directory, "SHA256SUMS");
    let catalogBytes: Buffer;
    let checksumsText: string;
    try {
      [catalogBytes, checksumsText] = await Promise.all([
        this.fetchSmall(candidate.catalog.url, signal),
        this.fetchSmall(candidate.checksums.url, signal).then((bytes) => bytes.toString("utf8"))
      ]);
    } catch (error) {
      // Offline: a catalog accepted before is accepted again from disk, under
      // the same rules and against the same release record.
      if (!(await exists(catalogPath))) throw error;
      catalogBytes = await readFile(catalogPath);
      checksumsText = await readFile(sumsPath, "utf8");
    }
    const accepted = acceptCatalog({
      candidate,
      catalogBytes,
      checksumsText,
      key: this.key as PlatformKey,
      consumerSha256: this.deps.bundled.consumerSha256
    });
    await mkdir(directory, { recursive: true });
    await writeFile(catalogPath, catalogBytes);
    await writeFile(sumsPath, checksumsText);
    return accepted;
  }

  private async fetchSmall(url: string, signal?: AbortSignal): Promise<Buffer> {
    const timeout = AbortSignal.timeout(30_000);
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    });
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status} for ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_METADATA_BYTES) throw new CatalogError(`${url} is larger than a release catalog can be`);
    return bytes;
  }

  // ---------- install ----------

  /**
   * Download, verify and install `version`. A second call for the same
   * version joins the first; a different version waits for nothing and is
   * refused, so two installs never share the staging area.
   */
  install(version: string): Promise<ManagedGitStatus> {
    if (this.running !== null) {
      if (this.running.version === version) return this.running.promise;
      return Promise.reject(new ManagedGitInstallError(`${this.running.version} is still installing.`, "checking"));
    }
    const abort = new AbortController();
    const promise = this.runInstall(version, abort.signal).finally(() => {
      if (this.running?.promise === promise) this.running = null;
    });
    this.running = { version, promise, abort };
    return promise;
  }

  cancel(): void {
    this.running?.abort.abort(new Error("Cancelled"));
  }

  private async runInstall(version: string, signal: AbortSignal): Promise<ManagedGitStatus> {
    let phase: ManagedGitInstallPhase | "checking" = "checking";
    const step = (next: ManagedGitInstallPhase): void => {
      if (signal.aborted) throw signal.reason;
      phase = next;
      this.publish({ phase: next, version });
    };
    this.publish({ phase: "checking", version });
    let release: (() => Promise<void>) | null = null;
    let staging: string | null = null;
    try {
      if (this.key === null) throw new ManagedGitInstallError("PwrGit offers no build of its Git for this machine.", "checking");
      if (!this.candidates.some((candidate) => candidate.version === version)) await this.runCheck(false);
      const candidate = this.candidates.find((entry) => entry.version === version);
      if (candidate === undefined) throw new ManagedGitInstallError(`${version} is not a build this PwrGit can install.`, "checking");
      const accepted = await this.acceptCandidate(candidate, signal);
      const id = buildId(accepted.pin.version, accepted.pin.sourceRevision);
      release = await this.lock();
      const store = await this.readStore();
      if (store.builds.some((build) => build.id === id) && (await exists(this.payloadDir(id)))) {
        await this.verifyBuild(id);
        this.publish({ phase: "ready", version });
        return await this.status();
      }

      await mkdir(this.deps.root, { recursive: true });
      staging = join(this.deps.root, `.staging-${randomUUID()}`);
      await mkdir(staging, { recursive: true });
      const archivesDir = join(this.deps.root, "archives");
      const cachedArchive = join(archivesDir, `${accepted.archiveSha256}.tar.gz`);

      step("downloading");
      const fromCache = (await exists(cachedArchive)) && (await sha256File(cachedArchive)) === accepted.archiveSha256;
      const archive = fromCache ? cachedArchive : join(staging, accepted.archiveName);
      if (!fromCache) await this.download(accepted.archiveUrl, archive, accepted.archiveSize, version, signal);
      // The check that gates extraction is always on the bytes about to be
      // unpacked, whether they were just downloaded or came from the cache.
      step("checksum");
      const actual = await sha256File(archive);
      if (actual !== accepted.archiveSha256) {
        await rm(archive, { force: true });
        throw new ManagedGitInstallError(
          `The download’s checksum doesn’t match the release (expected ${accepted.archiveSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Nothing was installed.`,
          "checksum"
        );
      }

      step("unpacking");
      const unpacked = join(staging, "runtime");
      await mkdir(unpacked);
      await (this.deps.extract ?? defaultExtract)(archive, unpacked, signal);

      step("verifying");
      const verified = await (this.deps.verify ?? verifyManagedRuntime)(unpacked, accepted.pin, { probe: false });
      step("testing");
      await (this.deps.probe ?? ((directory, pin) => probeManagedRuntime(directory, pin)))(unpacked, accepted.pin);

      if (signal.aborted) throw signal.reason;
      await mkdir(this.versionDir(id), { recursive: true });
      await writeFile(join(this.versionDir(id), "runtime-manifest.sha256"), `${accepted.catalogSha256}\n`);
      const target = this.payloadDir(id);
      if (await exists(target)) {
        // A leftover from an interrupted install, or a record that went
        // missing: never trusted, always replaced by what was just verified.
        const displaced = `${target}.replaced-${randomUUID()}`;
        await rename(target, displaced);
        await rm(displaced, { recursive: true, force: true });
      }
      await rename(unpacked, target);
      if (!fromCache) {
        await mkdir(archivesDir, { recursive: true });
        await rename(archive, cachedArchive).catch(() => undefined);
      }
      const record: BuildRecord = {
        id,
        version: accepted.pin.version,
        sourceRevision: accepted.pin.sourceRevision,
        key: this.key,
        inventorySha256: accepted.pin.asset.inventory_sha256,
        archiveSha256: accepted.archiveSha256,
        catalogSha256: accepted.catalogSha256,
        trust: this.key === "darwin-universal" ? "signed" : "checksum",
        lfsVersion: verified.lfsVersion,
        installedAt: this.now(),
        publishedAt: candidate.publishedAt
      };
      const current = await this.readStore();
      await this.writeStore({ ...current, builds: [...current.builds.filter((build) => build.id !== id), record] });
      this.verified.set(id, target);
      this.deps.log?.("info", `managed Git ${id} installed and verified at ${target}`);
      this.publish({ phase: "ready", version });
      return await this.status();
    } catch (error) {
      if (signal.aborted) {
        this.publish({ phase: "idle" });
        this.deps.log?.("info", `managed Git ${version} install cancelled`);
        throw new ManagedGitInstallError("Cancelled. Nothing was installed.", phase);
      }
      const failedPhase = error instanceof ManagedGitInstallError ? error.phase : phase;
      const message = errorText(error);
      this.publish({ phase: "failed", version, error: message, failedPhase });
      this.deps.log?.("warn", `managed Git ${version} install failed in ${failedPhase}: ${message}`);
      throw error instanceof ManagedGitInstallError ? error : new ManagedGitInstallError(message, failedPhase);
    } finally {
      if (staging !== null) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await release?.();
    }
  }

  private async download(url: string, target: string, size: number | null, version: string, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.any([signal, timeout])
    });
    if (!response.ok || response.body === null) {
      throw new ManagedGitInstallError(`Download failed with HTTP ${response.status}.`, "downloading");
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) {
      throw new ManagedGitInstallError("The download is larger than any build of PwrGit’s Git.", "downloading");
    }
    const total = size ?? (Number.isFinite(length) && length > 0 ? length : undefined);
    let received = 0;
    let lastAt = this.now();
    let lastBytes = 0;
    let rate: number | undefined;
    const report = (): void =>
      this.publish({
        phase: "downloading",
        version,
        receivedBytes: received,
        ...(total !== undefined ? { totalBytes: total } : {}),
        ...(rate !== undefined ? { bytesPerSecond: rate } : {})
      });
    report();
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > MAX_ARCHIVE_BYTES) {
          callback(new ManagedGitInstallError("The download is larger than any build of PwrGit’s Git.", "downloading"));
          return;
        }
        const at = this.now();
        if (at - lastAt >= PROGRESS_INTERVAL_MS) {
          const sample = (received - lastBytes) / ((at - lastAt) / 1000);
          rate = rate === undefined ? sample : rate * 0.7 + sample * 0.3;
          lastAt = at;
          lastBytes = received;
          report();
        }
        callback(null, chunk);
      }
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        meter,
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
        { signal }
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ManagedGitInstallError) throw error;
      throw new ManagedGitInstallError(
        `The download stopped at ${(received / 1e6).toFixed(1)}${total !== undefined ? ` of ${(total / 1e6).toFixed(1)}` : ""} MB: ${errorText(error)}`,
        "downloading"
      );
    }
    if (total !== undefined && size !== null && received !== size) {
      throw new ManagedGitInstallError(`The download ended at ${received} of ${size} bytes.`, "downloading");
    }
  }

  /** One install at a time across PwrGit processes (a packaged app and a
   *  dev build can share a data directory). The lock names its pid; a dead
   *  holder's lock is taken over. */
  private async lock(): Promise<() => Promise<void>> {
    const file = join(this.deps.root, ".install.lock");
    await mkdir(this.deps.root, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => {
          await unlink(file).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = Number((await readFile(file, "utf8").catch(() => "")).trim());
        if (Number.isSafeInteger(holder) && holder > 0 && holder !== process.pid && (this.deps.isProcessAlive ?? defaultProcessAlive)(holder)) {
          throw new ManagedGitInstallError("Another PwrGit is installing a build of its Git.", "checking");
        }
        await unlink(file).catch(() => undefined);
      }
    }
    throw new ManagedGitInstallError("Couldn’t take the install lock.", "checking");
  }

  // ---------- verification and activation ----------

  /**
   * The payload directory of a build, verified in this session: inventory,
   * file set, modes, links, build record, signatures (macOS) and a test run.
   * Verified once per session; its directory never changes afterwards.
   */
  async verifyBuild(id: string): Promise<string> {
    const known = this.verified.get(id);
    if (known !== undefined) return known;
    const store = await this.readStore();
    const record = store.builds.find((build) => build.id === id);
    if (record === undefined || this.key === null) throw new Error(`${id} is not installed.`);
    const directory = this.payloadDir(id);
    const pin: RuntimePin = {
      version: record.version,
      sourceRevision: record.sourceRevision,
      key: this.key,
      asset: { sha256: record.archiveSha256, inventory_sha256: record.inventorySha256, url: "" }
    };
    await (this.deps.verify ?? verifyManagedRuntime)(directory, pin, { probe: true });
    this.verified.set(id, directory);
    return directory;
  }

  /** Verified builds other than the one in use, for the Installs list. */
  async verifiedBuilds(): Promise<Array<{ build: ManagedGitBuild; directory: string | null; error: string | null }>> {
    const status = await this.status();
    return Promise.all(
      status.builds.map(async (build) => {
        try {
          return { build, directory: await this.verifyBuild(build.id), error: null };
        } catch (error) {
          return { build, directory: null, error: errorText(error) };
        }
      })
    );
  }

  /**
   * Launch: verify the stored choice and return its directory, or null when
   * none is chosen (or an installed Git outranks it). A choice that fails
   * its check rejects: the caller makes Git refuse rather than run the bundle.
   */
  async activateStored(): Promise<string | null> {
    const selected = this.deps.selection().selected;
    if (selected === undefined || this.key === null || this.deps.installedOverride()) return null;
    try {
      const directory = await this.verifyBuild(selected);
      this.selectedError = null;
      return directory;
    } catch (error) {
      this.selectedError = `PwrGit’s Git ${selected} failed its check at launch (${errorText(error)}). Choose another Git in Settings › Git.`;
      this.deps.log?.("error", this.selectedError);
      throw new Error(this.selectedError);
    }
  }

  /** The choice changed (Settings): a failed launch check no longer applies. */
  clearSelectedError(): void {
    this.selectedError = null;
  }

  /**
   * Launch only, before any Git runs: remove builds nobody can reach. Kept:
   * the chosen build, the one chosen before it (rollback), and the newest
   * (just downloaded, maybe not yet used). Running this at launch is what
   * keeps a build a running command started on from being deleted under it.
   */
  async prune(): Promise<void> {
    if (this.key === null) return;
    const store = await this.readStore();
    const selection = this.deps.selection();
    const newest = (await this.status()).builds[0]?.id;
    const keep = new Set([selection.selected, selection.previous, newest].filter((id): id is string => id !== undefined));
    const kept = store.builds.filter((build) => keep.has(build.id));
    if (kept.length !== store.builds.length) await this.writeStore({ ...store, builds: kept });
    const versions = join(this.deps.root, "versions");
    for (const name of await readdir(versions).catch(() => [] as string[])) {
      if (!kept.some((build) => build.id === name)) {
        await rm(join(versions, name), { recursive: true, force: true }).catch((error: unknown) =>
          this.deps.log?.("warn", `managed Git prune of ${name} failed: ${errorText(error)}`)
        );
      }
    }
    const archives = join(this.deps.root, "archives");
    const keepArchives = new Set(kept.map((build) => `${build.archiveSha256}.tar.gz`));
    for (const name of await readdir(archives).catch(() => [] as string[])) {
      if (!keepArchives.has(name)) await rm(join(archives, name), { force: true }).catch(() => undefined);
    }
    for (const name of await readdir(this.deps.root).catch(() => [] as string[])) {
      if (name.startsWith(".staging-")) await rm(join(this.deps.root, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
