import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ManagedGitProgress, ManagedGitTrack } from "@pwrgit/shared";
import { MANAGED_GIT_RELEASES_URL, type PlatformKey } from "./catalog";
import { ManagedGitService, type ManagedGitSelection } from "./managed-git-service";
import { archive, fixtureRelease, rawTarGz, sha256, writePayload, type FixtureRelease } from "./test-fixture";
import { verifyManagedRuntime } from "./verify-runtime";

const CONSUMER = "03a2dac8d3bd2a97f28c580a617b09aeb950ce03e8489b6c604da4e3488a6bf4";
const BUNDLED = "2.56.0-dev-pwrgit.4";
let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-managed-service-")));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function build(
  version: string,
  key: PlatformKey = "linux-x64",
  options: { tamper?: boolean; consumer?: string; revision?: string; prerelease?: boolean } = {}
): FixtureRelease {
  const root = join(scratch, `payload-${counter++}`);
  const pin = writePayload(root, { version, key, ...(options.revision ? { revision: options.revision } : {}) });
  if (options.tamper) writeFileSync(join(root, "bin", "git-lfs"), "#!/bin/sh\necho planted\n");
  const bytes = archive(root, join(scratch, `archive-${counter++}.tar.gz`));
  return fixtureRelease({
    version,
    key,
    archive: bytes,
    inventorySha256: pin.asset.inventory_sha256,
    consumerSha256: options.consumer ?? CONSUMER,
    ...(options.revision ? { revision: options.revision } : {}),
    ...(options.prerelease !== undefined ? { prerelease: options.prerelease } : {})
  });
}

type Server = {
  fetch: typeof fetch;
  hits: string[];
  offline: boolean;
  /** Per archive URL: replace the body. */
  archiveBody: Map<string, () => ReadableStream<Uint8Array>>;
};

function serve(releases: FixtureRelease[], listOverride?: unknown[]): Server {
  const server: Server = {
    hits: [],
    offline: false,
    archiveBody: new Map(),
    fetch: async (input, init) => {
      const url = String(input);
      server.hits.push(url);
      if (server.offline) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
      if (url === MANAGED_GIT_RELEASES_URL) return Response.json(listOverride ?? releases.map((r) => r.release));
      for (const r of releases) {
        const base = `https://github.com/huntharo/git/releases/download/${r.tag}/`;
        if (url === base + "runtime-manifest.json") return new Response(new Uint8Array(r.catalog));
        if (url === base + "SHA256SUMS") return new Response(r.sums);
        if (url === base + r.archiveName) {
          const body = server.archiveBody.get(url)?.() ?? new Blob([new Uint8Array(r.archive)]).stream();
          void init;
          return new Response(body, { headers: { "content-length": String(r.archive.length) } });
        }
      }
      return new Response("missing", { status: 404 });
    }
  };
  return server;
}

function service(
  server: Server,
  options: {
    key?: "x64" | "arm64";
    selection?: ManagedGitSelection;
    installed?: boolean;
    pid?: number;
    alive?: (pid: number) => boolean;
    track?: { current: ManagedGitTrack };
  } = {}
) {
  const progress: ManagedGitProgress[] = [];
  const probes: string[] = [];
  const selection: ManagedGitSelection = options.selection ?? {};
  const svc = new ManagedGitService({
    root: join(scratch, "git-runtimes"),
    platform: "linux",
    arch: options.key ?? "x64",
    bundled: { version: BUNDLED, consumerSha256: CONSUMER },
    selection: () => selection,
    ...(options.track === undefined ? {} : { track: () => options.track!.current }),
    installedOverride: () => options.installed === true,
    fetch: server.fetch,
    verify: (directory, pin, verifyOptions) => verifyManagedRuntime(directory, pin, { ...verifyOptions, probe: false }),
    probe: async (directory) => {
      probes.push(directory);
    },
    onProgress: (event) => progress.push(event),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.alive === undefined ? {} : { isProcessAlive: options.alive })
  });
  return { svc, progress, probes, selection };
}

const root = () => join(scratch, "git-runtimes");
const leftovers = () => readdirSync(root()).filter((name) => name.startsWith(".staging-") || name === ".install.lock");

describe("ManagedGitService", () => {
  test("checks the release list, installs and verifies, and never changes the selection", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([five]);
    const { svc, progress, probes, selection } = service(server);
    const checked = await svc.check({ force: true });
    expect(checked.latest).toMatchObject({ version: "2.56.0-dev-pwrgit.5", tag: "v2.56.0-dev-pwrgit.5" });
    const status = await svc.install("2.56.0-dev-pwrgit.5");
    expect(status.builds.map((b) => b.id)).toEqual(["2.56.0-dev-pwrgit.5-97dd200"]);
    expect(status.selected).toBeNull();
    expect(status.inUse).toBe(false);
    expect(selection).toEqual({});
    expect(existsSync(join(root(), "versions", "2.56.0-dev-pwrgit.5-97dd200", "linux-x64", "bin", "git"))).toBe(true);
    expect(existsSync(join(root(), "archives", `${sha256(five.archive)}.tar.gz`))).toBe(true);
    expect(probes).toHaveLength(1);
    expect(progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1])).toEqual([
      "checking", "downloading", "checksum", "unpacking", "verifying", "testing", "ready"
    ]);
    expect(leftovers()).toEqual([]);
  });

  test("a download whose bytes differ from the release is refused before it is unpacked", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([five]);
    const corrupted = Buffer.from(five.archive);
    corrupted[100] = (corrupted[100] ?? 0) ^ 0xff;
    server.archiveBody.set(`https://github.com/huntharo/git/releases/download/${five.tag}/${five.archiveName}`, () => new Blob([corrupted]).stream());
    const { svc, progress } = service(server);
    await svc.check({ force: true });
    await expect(svc.install("2.56.0-dev-pwrgit.5")).rejects.toThrow(/checksum doesn’t match/);
    expect(progress.at(-1)).toMatchObject({ phase: "failed", failedPhase: "checksum" });
    expect(progress.some((p) => p.phase === "unpacking")).toBe(false);
    expect((await svc.status()).builds).toEqual([]);
    expect(existsSync(join(root(), "archives"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("an archive whose files differ from its sealed inventory is refused, and nothing is kept", async () => {
    const tampered = build("2.56.0-dev-pwrgit.5", "linux-x64", { tamper: true });
    const { svc, progress } = service(serve([tampered]));
    await svc.check({ force: true });
    await expect(svc.install("2.56.0-dev-pwrgit.5")).rejects.toThrow(/bytes, mode or link changed: bin\/git-lfs/);
    expect(progress.at(-1)).toMatchObject({ phase: "failed", failedPhase: "verifying" });
    expect(existsSync(join(root(), "versions"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test.each([
    ["a parent-directory member", "../escape"],
    ["an absolute member", "/tmp/pwrgit-managed-absolute-member"]
  ])("an archive with %s is refused before tar writes anything", async (_kind, member) => {
    // The archive's own checksum is right: the catalog vouches for these bytes,
    // so only the member rule stands between them and the disk.
    const bytes = rawTarGz([{ name: "bin/git", body: "#!/bin/sh\n" }, { name: member, body: "planted\n" }]);
    const five = fixtureRelease({ version: "2.56.0-dev-pwrgit.5", key: "linux-x64", archive: bytes, inventorySha256: "0".repeat(64), consumerSha256: CONSUMER });
    const { svc, progress } = service(serve([five]));
    await svc.check({ force: true });
    await expect(svc.install("2.56.0-dev-pwrgit.5")).rejects.toThrow(`The archive has an unsafe member (${member}), so nothing was unpacked.`);
    expect(progress.at(-1)).toMatchObject({ phase: "failed", failedPhase: "unpacking" });
    expect(existsSync(join(root(), "escape"))).toBe(false);
    expect(existsSync(join(scratch, "escape"))).toBe(false);
    expect(existsSync(member.startsWith("/") ? member : join(root(), member))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("a Linux build whose CA bundle isn't the one its release names is refused", async () => {
    const payload = join(scratch, "payload-ca");
    const pin = writePayload(payload, { version: "2.56.0-dev-pwrgit.5", key: "linux-x64" });
    const bytes = archive(payload, join(scratch, "archive-ca.tar.gz"));
    const five = fixtureRelease({
      version: "2.56.0-dev-pwrgit.5",
      key: "linux-x64",
      archive: bytes,
      inventorySha256: pin.asset.inventory_sha256,
      consumerSha256: CONSUMER,
      caBundleSha256: "c".repeat(64)
    });
    const { svc, progress } = service(serve([five]));
    await svc.check({ force: true });
    await expect(svc.install("2.56.0-dev-pwrgit.5")).rejects.toThrow(/CA bundle doesn’t match its release/);
    expect(progress.at(-1)).toMatchObject({ phase: "failed", failedPhase: "verifying" });
  });

  test("another publisher's assets and another platform's archive offer nothing", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const foreign = structuredClone(five.release) as { assets: Array<Record<string, unknown>> };
    for (const asset of foreign.assets) asset["browser_download_url"] = String(asset["browser_download_url"]).replace("huntharo/git", "mallory/git");
    expect((await service(serve([five], [foreign])).svc.check({ force: true })).latest).toBeNull();
    expect((await service(serve([five]), { key: "arm64" }).svc.check({ force: true })).latest).toBeNull();
  });

  test("a release built for a newer stager is reported as needing an app update; the newest one this app can verify is offered", async () => {
    const six = build("2.56.0-dev-pwrgit.6", "linux-x64", { consumer: "f".repeat(64), revision: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const five = build("2.56.0-dev-pwrgit.5");
    const status = await service(serve([six, five])).svc.check({ force: true });
    expect(status.latest?.version).toBe("2.56.0-dev-pwrgit.5");
    expect(status.needsAppUpdate).toBe("2.56.0-dev-pwrgit.6");
  });

  test("an interrupted download fails cleanly, and the next attempt installs", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([five]);
    const url = `https://github.com/huntharo/git/releases/download/${five.tag}/${five.archiveName}`;
    server.archiveBody.set(url, () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(five.archive.subarray(0, 200));
          controller.error(new Error("ECONNRESET"));
        }
      })
    );
    const { svc } = service(server);
    await svc.check({ force: true });
    await expect(svc.install("2.56.0-dev-pwrgit.5")).rejects.toThrow(/stopped at 0\.0 of .* MB: ECONNRESET/);
    expect(leftovers()).toEqual([]);
    server.archiveBody.delete(url);
    expect((await svc.install("2.56.0-dev-pwrgit.5")).builds).toHaveLength(1);
  });

  test("Cancel stops a download, keeps nothing, and clears the progress strip", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([five]);
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    server.archiveBody.set(`https://github.com/huntharo/git/releases/download/${five.tag}/${five.archiveName}`, () =>
      new ReadableStream({
        pull(controller) {
          controller.enqueue(five.archive.subarray(0, 64));
          started();
          return new Promise(() => undefined);
        }
      })
    );
    const { svc, progress } = service(server);
    await svc.check({ force: true });
    const install = svc.install("2.56.0-dev-pwrgit.5");
    await begun;
    svc.cancel();
    await expect(install).rejects.toThrow(/Cancelled/);
    expect(progress.at(-1)?.phase).toBe("idle");
    expect((await svc.status()).builds).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test("two installs of one version share one download; a different version waits its turn", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([five]);
    const { svc } = service(server);
    await svc.check({ force: true });
    const first = svc.install("2.56.0-dev-pwrgit.5");
    const second = svc.install("2.56.0-dev-pwrgit.5");
    await expect(svc.install("2.56.0-dev-pwrgit.6")).rejects.toThrow(/still installing/);
    expect(await first).toEqual(await second);
    expect(server.hits.filter((url) => url.endsWith(".tar.gz"))).toHaveLength(1);
  });

  test("a stale lock from a dead PwrGit is taken over; a live one refuses", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const { svc } = service(serve([five]));
    await svc.check({ force: true });
    writeFileSync(join(root(), ".install.lock"), "999999");
    expect((await svc.install("2.56.0-dev-pwrgit.5")).builds).toHaveLength(1);
    rmSync(join(root(), "versions"), { recursive: true });
    rmSync(join(root(), "builds.json"));
    const fresh = service(serve([five])).svc;
    await fresh.check({ force: true });
    writeFileSync(join(root(), ".install.lock"), String(process.ppid));
    await expect(fresh.install("2.56.0-dev-pwrgit.5")).rejects.toThrow(/Another PwrGit is installing/);
  });

  test("offline, a reinstall uses the verified cached catalog and archive, and no network at all succeeds", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const online = serve([five]);
    const first = service(online).svc;
    await first.check({ force: true });
    await first.install("2.56.0-dev-pwrgit.5");
    // The install went missing (a cleanup, a restored backup): its archive
    // and catalog are still in the cache.
    rmSync(join(root(), "versions"), { recursive: true });
    rmSync(join(root(), "builds.json"));
    const offline = serve([five]);
    offline.offline = true;
    const second = service(offline).svc;
    const status = await second.install("2.56.0-dev-pwrgit.5");
    expect(status.builds.map((b) => b.id)).toEqual(["2.56.0-dev-pwrgit.5-97dd200"]);
    expect(offline.hits.every((url) => !url.endsWith(".tar.gz"))).toBe(true);
  });

  test("offline, a check keeps the last good answer and says why it could not look", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([five]);
    const { svc } = service(server);
    await svc.check({ force: true });
    server.offline = true;
    const status = await svc.check({ force: true });
    expect(status.latest?.version).toBe("2.56.0-dev-pwrgit.5");
    expect(status.checkError).toMatch(/ENOTFOUND/);
  });

  test("launch verifies the chosen build; a tampered one is refused by name, never run", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const first = service(serve([five])).svc;
    await first.check({ force: true });
    await first.install("2.56.0-dev-pwrgit.5");
    const chosen = { selected: "2.56.0-dev-pwrgit.5-97dd200" };
    const launch = service(serve([five]), { selection: chosen });
    expect(await launch.svc.activateStored()).toBe(join(root(), "versions", "2.56.0-dev-pwrgit.5-97dd200", "linux-x64"));
    expect(launch.probes).toHaveLength(0); // verification at launch probes via the real verifier; the stub runs no Git

    writeFileSync(join(root(), "versions", "2.56.0-dev-pwrgit.5-97dd200", "linux-x64", "etc", "gitconfig"), "[core]\n\tfsmonitor = /tmp/x\n");
    const tampered = service(serve([five]), { selection: chosen });
    await expect(tampered.svc.activateStored()).rejects.toThrow(/failed its check at launch .*etc\/gitconfig.*Settings › Git/);
    expect((await tampered.svc.status()).selectedError).toMatch(/failed its check/);
    expect((await tampered.svc.status()).inUse).toBe(false);
  });

  test("an installed Git chosen in Settings outranks the chosen build at launch", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const first = service(serve([five])).svc;
    await first.check({ force: true });
    await first.install("2.56.0-dev-pwrgit.5");
    const launch = service(serve([five]), { selection: { selected: "2.56.0-dev-pwrgit.5-97dd200" }, installed: true });
    expect(await launch.svc.activateStored()).toBeNull();
    expect((await launch.svc.status()).inUse).toBe(false);
  });

  test("launch pruning keeps the chosen build, the one before it and the newest", async () => {
    const releases = ["5", "6", "7", "8"].map((n) => build(`2.56.0-dev-pwrgit.${n}`, "linux-x64", { revision: `${n}${"0".repeat(39)}` }));
    const server = serve(releases);
    const { svc } = service(server);
    for (const r of releases) {
      // A second instance on the same root checking between installs must
      // not write back a stale build list.
      await svc.check({ force: true });
      // The check offers the newest; install older ones through their own list.
      const only = serve([r]);
      const one = service(only).svc;
      await one.check({ force: true });
      await one.install(r.version);
    }
    const ids = releases.map((r) => `${r.version}-${r.version.slice(-1)}000000`);
    const launch = service(server, { selection: { selected: ids[1], previous: ids[0] } });
    await launch.svc.prune();
    expect((await launch.svc.status()).builds.map((b) => b.id).sort()).toEqual([ids[0], ids[1], ids[3]].sort());
    expect(readdirSync(join(root(), "versions")).sort()).toEqual([ids[0], ids[1], ids[3]].sort());
    expect(readdirSync(join(root(), "archives"))).toHaveLength(3);
    const stored = JSON.parse(readFileSync(join(root(), "builds.json"), "utf8")) as { builds: unknown[] };
    expect(stored.builds).toHaveLength(3);
  });

  // Rule: a reinstall repairs a damaged copy; it never fails the same check
  // forever because a record of the build exists.
  test("downloading a build again repairs a damaged copy of it", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const { svc } = service(serve([five]));
    await svc.check({ force: true });
    await svc.install("2.56.0-dev-pwrgit.5");
    const config = join(root(), "versions", "2.56.0-dev-pwrgit.5-97dd200", "linux-x64", "etc", "gitconfig");
    const original = readFileSync(config, "utf8");
    writeFileSync(config, "[core]\n\tfsmonitor = /tmp/x\n");
    const again = service(serve([five])).svc;
    await again.check({ force: true });
    expect((await again.install("2.56.0-dev-pwrgit.5")).builds.map((b) => b.id)).toEqual(["2.56.0-dev-pwrgit.5-97dd200"]);
    expect(readFileSync(config, "utf8")).toBe(original);
    const launch = service(serve([five]), { selection: { selected: "2.56.0-dev-pwrgit.5-97dd200" } });
    expect(await launch.svc.activateStored()).not.toBeNull();
  });

  // Rule: launch pruning never removes what another PwrGit sharing the
  // directory is installing.
  test("launch pruning leaves another PwrGit's install alone", async () => {
    mkdirSync(join(root(), ".staging-elsewhere", "runtime"), { recursive: true });
    writeFileSync(join(root(), ".install.lock"), "4242");
    const { svc } = service(serve([]), { pid: 1000, alive: (pid) => pid === 4242 });
    await svc.prune();
    expect(existsSync(join(root(), ".staging-elsewhere", "runtime"))).toBe(true);
    expect(readFileSync(join(root(), ".install.lock"), "utf8")).toBe("4242");
    // Once nobody holds the lock, the leftover goes.
    rmSync(join(root(), ".install.lock"));
    await svc.prune();
    expect(existsSync(join(root(), ".staging-elsewhere"))).toBe(false);
  });

  // Rule: the Linux CA bundle the release named is checked every time a
  // build is verified, not only when it was installed.
  test("launch checks a Linux build's CA bundle against the one its release named", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const first = service(serve([five])).svc;
    await first.check({ force: true });
    await first.install("2.56.0-dev-pwrgit.5");
    const store = JSON.parse(readFileSync(join(root(), "builds.json"), "utf8")) as { builds: Array<Record<string, unknown>> };
    expect(store.builds[0]?.["caBundleSha256"]).toMatch(/^[0-9a-f]{64}$/);
    store.builds[0]!["caBundleSha256"] = "c".repeat(64);
    writeFileSync(join(root(), "builds.json"), JSON.stringify(store));
    const launch = service(serve([five]), { selection: { selected: "2.56.0-dev-pwrgit.5-97dd200" } });
    await expect(launch.svc.activateStored()).rejects.toThrow(/CA bundle doesn’t match its release/);
  });

  // Rule: release metadata is read no further than its size cap.
  test("an oversized release catalog is refused without reading all of it", async () => {
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([five]);
    const catalogUrl = `https://github.com/huntharo/git/releases/download/${five.tag}/runtime-manifest.json`;
    let pulled = 0;
    const inner = server.fetch;
    server.fetch = async (input, init) => {
      if (String(input) !== catalogUrl) return inner(input, init);
      const chunk = new Uint8Array(64 * 1024).fill(0x20);
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += chunk.length;
            if (pulled > 64 * 1024 * 1024) controller.close();
            else controller.enqueue(chunk);
          }
        })
      );
    };
    const { svc } = service(server);
    const status = await svc.check({ force: true });
    expect(status.latest).toBeNull();
    expect(status.checkError ?? "").toMatch(/larger than a release catalog can be/);
    expect(pulled).toBeLessThan(4 * 1024 * 1024);
  });

  // Rule: Latest offers only promoted releases; Prerelease the newest,
  // promoted or not. One check answers both, so switching asks GitHub nothing
  // and never changes the selection.
  test("each track offers its own newest build, and switching asks GitHub nothing", async () => {
    const six = build("2.56.0-dev-pwrgit.6", "linux-x64", { prerelease: true, revision: "6".repeat(40) });
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([six, five]);
    const track = { current: "latest" as ManagedGitTrack };
    const { svc, selection } = service(server, { track });
    const checked = await svc.check({ force: true });
    expect(checked.track).toBe("latest");
    expect(checked.tracks).toEqual({ latest: "2.56.0-dev-pwrgit.5", prerelease: "2.56.0-dev-pwrgit.6" });
    expect(checked.latest?.version).toBe("2.56.0-dev-pwrgit.5");
    const hits = server.hits.length;
    track.current = "prerelease";
    const switched = await svc.status();
    expect(switched.latest?.version).toBe("2.56.0-dev-pwrgit.6");
    expect(server.hits).toHaveLength(hits);
    expect((await svc.install("2.56.0-dev-pwrgit.6")).builds.map((b) => b.version)).toEqual(["2.56.0-dev-pwrgit.6"]);
    expect(selection).toEqual({});
  });

  test("with nothing promoted, Latest offers nothing and says nothing went wrong", async () => {
    const five = build("2.56.0-dev-pwrgit.5", "linux-x64", { prerelease: true });
    const status = await service(serve([five])).svc.check({ force: true });
    expect(status.track).toBe("latest");
    expect(status.latest).toBeNull();
    expect(status.tracks).toEqual({ latest: null, prerelease: "2.56.0-dev-pwrgit.5" });
    expect(status.checkError).toBeNull();
    expect(status.needsAppUpdate).toBeNull();
  });

  test("a prerelease that needs a newer PwrGit is news only on the Prerelease track", async () => {
    const six = build("2.56.0-dev-pwrgit.6", "linux-x64", { prerelease: true, consumer: "f".repeat(64), revision: "6".repeat(40) });
    const five = build("2.56.0-dev-pwrgit.5");
    const track = { current: "latest" as ManagedGitTrack };
    const { svc } = service(serve([six, five]), { track });
    expect((await svc.check({ force: true })).needsAppUpdate).toBeNull();
    track.current = "prerelease";
    const prerelease = await svc.status();
    expect(prerelease.needsAppUpdate).toBe("2.56.0-dev-pwrgit.6");
    expect(prerelease.latest?.version).toBe("2.56.0-dev-pwrgit.5");
  });

  test("prereleases older than the newest are never fetched while looking for a promoted build", async () => {
    const seven = build("2.56.0-dev-pwrgit.7", "linux-x64", { prerelease: true, revision: "7".repeat(40) });
    const six = build("2.56.0-dev-pwrgit.6", "linux-x64", { prerelease: true, revision: "6".repeat(40) });
    const five = build("2.56.0-dev-pwrgit.5");
    const server = serve([seven, six, five]);
    const status = await service(server).svc.check({ force: true });
    expect(status.tracks).toEqual({ latest: "2.56.0-dev-pwrgit.5", prerelease: "2.56.0-dev-pwrgit.7" });
    expect(server.hits.some((url) => url.includes(six.tag))).toBe(false);
  });

  test("a check saved before tracks existed answers for neither track", async () => {
    mkdirSync(root(), { recursive: true });
    writeFileSync(
      join(root(), "builds.json"),
      JSON.stringify({
        version: 1,
        builds: [],
        lastCheck: { checkedAt: 1, latest: { version: "2.56.0-dev-pwrgit.5", tag: "v2.56.0-dev-pwrgit.5", publishedAt: null, size: null }, needsAppUpdate: null }
      })
    );
    const status = await service(serve([])).svc.status();
    expect(status.checkedAt).toBeNull();
    expect(status.latest).toBeNull();
    expect(status.tracks).toEqual({ latest: null, prerelease: null });
  });
});
