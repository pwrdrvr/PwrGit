import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { markRetryableTestBody } from "../../../../../scripts/ci/vitest-test-body.ts";
import { ChromiumTrace } from "./chromium-trace";

const emptyTrace = JSON.stringify({ traceEvents: [] });
const stalledWorker = new URL(`data:text/javascript,${encodeURIComponent(`
  import { workerData } from "node:worker_threads";
  import { writeFileSync } from "node:fs";
  writeFileSync(workerData.filteredPath, '{"traceEvents":[');
  setInterval(() => {}, 1_000);
`)}`);

async function waitForPartialExport(directory: string): Promise<void> {
  await vi.waitFor(async () => {
    const staging = (await readdir(directory)).find((name) => name.startsWith(".pwrgit-trace-"));
    expect(staging).toBeDefined();
    await expect(readFile(join(directory, staging!, "filtered.json"), "utf8")).resolves.toBe('{"traceEvents":[');
  }, { timeout: 3_000 });
}

it("reserves one frozen export across overlapping triggers, rearming, disarm and clock adjustments", async ({ task }) => {
  markRetryableTestBody(task);
  await fc.assert(fc.asyncProperty(
    fc.array(fc.tuple(fc.integer({ min: 2, max: 5 }), fc.integer({ min: 1, max: 1000 }),
      fc.constantFrom("publish", "profile-failed", "disarm", "disarm-after-filtering")), { minLength: 1, maxLength: 12 }),
    async (rounds) => {
      const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-model-"));
      try {
        let mono = 0;
        let wall = 100_000;
        let nativeRecording = false;
        let rawPath: string | undefined;
        let filterCheckpoint: (() => Promise<void>) | undefined;
        const unexpectedErrors: unknown[] = [];
        const trace = new ChromiumTrace(() => ({
          async startRecording() {
            expect(nativeRecording).toBe(false);
            nativeRecording = true;
          },
          async stopRecording(file = join(directory, "discard.json")) {
            expect(nativeRecording).toBe(true);
            rawPath = file;
            await writeFile(file, emptyTrace);
            nativeRecording = false;
            return file;
          }
        }), (_message, error) => unexpectedErrors.push(error), {
          wallNow: () => wall,
          monotonicNow: () => ++mono,
          // The queue model uses empty exports. The export tests below run the real worker.
          filterTrace: async (_rawPath, filteredPath) => {
            await writeFile(filteredPath, emptyTrace);
            await filterCheckpoint?.();
          }
        });

        const saved: string[] = [];
        for (const [index, [count, rollback, settlement]] of rounds.entries()) {
          await Promise.all([trace.setArmed(true), trace.setArmed(true)]);
          expect(nativeRecording).toBe(true);
          const trigger = ++mono;
          wall -= rollback;
          const names = Array.from({ length: count }, (_, i) => `capture-${index}-${i}.json`);
          let completeProfile!: (written: boolean) => void;
          const profileWritten = new Promise<boolean>((resolve) => { completeProfile = resolve; });
          const capture = trace.capture(join(directory, names[0]!), trigger, () => profileWritten);
          const otherCaptures = await Promise.all([
            trace.setArmed(true),
            ...names.slice(1).map((name) => trace.capture(join(directory, name), trigger))
          ]);
          expect(nativeRecording).toBe(false);
          expect(otherCaptures.slice(1)).toEqual(names.slice(1).map(() => ({ status: "skipped", reason: "not-recording" })));
          expect(await readFile(rawPath!, "utf8")).toBe(emptyTrace);
          expect((await readdir(directory)).sort()).toEqual(saved.sort());

          if (settlement === "disarm") {
            await trace.setArmed(false);
          } else if (settlement === "disarm-after-filtering") {
            let reachedCheckpoint!: () => void;
            let releaseFilter!: () => void;
            const reached = new Promise<void>((resolve) => { reachedCheckpoint = resolve; });
            const released = new Promise<void>((resolve) => { releaseFilter = resolve; });
            filterCheckpoint = () => {
              reachedCheckpoint();
              return released;
            };
            completeProfile(true);
            await reached;
            const disarm = trace.setArmed(false);
            releaseFilter();
            await disarm;
            filterCheckpoint = undefined;
          } else {
            completeProfile(settlement === "publish");
          }
          if (settlement === "publish") {
            expect(await capture).toMatchObject({ status: "written" });
            saved.push(names[0]!);
          } else {
            expect(await capture).toEqual({ status: "skipped", reason: "canceled" });
          }
          if (settlement === "disarm") completeProfile(true);
          await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
          await trace.setArmed(true);
          expect(nativeRecording).toBe(true);
          await expect(trace.capture(join(directory, "stale.json"), trigger)).resolves.toEqual({
            status: "skipped", reason: "trigger-predates-recording"
          });
        }
        await Promise.all([trace.setArmed(false), trace.setArmed(false)]);
        expect(nativeRecording).toBe(false);
        expect(unexpectedErrors).toEqual([]);
        expect((await readdir(directory)).sort()).toEqual(saved.sort());
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  ), { numRuns: 25 });
});

it.each(["profile deadline", "shutdown"] as const)("releases a stalled CPU profile's trace reservation on %s", async (stop) => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-profile-stalled-"));
  let rawPath: string | undefined;
  let mono = 0;
  let nativeStarts = 0;
  const trace = new ChromiumTrace(() => ({
    async startRecording() { nativeStarts++; },
    async stopRecording(file = "") {
      rawPath = file;
      await writeFile(file, emptyTrace);
      return file;
    }
  }), () => {}, { monotonicNow: () => ++mono });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await trace.setArmed(true);
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const output = join(directory, "trace.json");
    const result = trace.capture(output, ++mono, () => {
      markWaiting();
      return new Promise<never>(() => {});
    }).catch((error: Error) => error);
    await waiting;
    if (stop === "shutdown") trace.beginShutdown(1_000);
    await vi.advanceTimersByTimeAsync(stop === "shutdown" ? 1_000 : 15_000);
    await vi.waitFor(async () => {
      await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 500 });
    const message = stop === "shutdown" ? /Chromium trace timed out during shutdown/i : /waiting for CPU profile timed out/i;
    expect(await result).toMatchObject({ message: expect.stringMatching(message) });
    expect(await readdir(directory)).toEqual([]);
    if (stop === "profile deadline") {
      await trace.setArmed(true);
      expect(nativeStarts).toBe(2);
    }
  } finally {
    await trace.setArmed(false);
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds a missing start acknowledgement and an export that never completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-timeout-"));
  const output = join(directory, "trace.json");
  const hangs = () => new Promise<never>(() => {});
  try {
    let mono = 0;
    const warnings: unknown[] = [];
    let startCount = 0;
    let stopCount = 0;
    const trace = new ChromiumTrace(() => ({
      async startRecording() {
        if (++startCount === 1) await hangs();
      },
      async stopRecording(file = join(directory, "discard.json")) {
        stopCount++;
        if (stopCount === 2) await hangs();
        await writeFile(file, emptyTrace);
        return file;
      }
    }), (_message, error) => warnings.push(error), {
      monotonicNow: () => ++mono,
      startTimeoutMs: 30,
      stopTimeoutMs: 30
    });

    await trace.setArmed(true);
    expect(warnings).toHaveLength(1);
    await trace.setArmed(true);
    await expect(trace.capture(output, ++mono)).rejects.toThrow(/stopping Chromium trace timed out/i);
    expect(await readdir(directory)).toEqual([]);

    await trace.setArmed(true);
    await expect(trace.capture(output, ++mono)).resolves.toMatchObject({ status: "written" });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ traceEvents: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


it("streams the allowlisted projection at the full 288 MiB export limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-large-trace-oracle-"));
  const output = join(directory, "trace.json");
  const compound = {
    cat: "devtools.timeline,private-category",
    name: "Layout",
    ph: "X",
    pid: 120,
    tid: 141,
    ts: 2_010,
    dur: 830,
    args: { beginData: { frame: "private-layout-frame" }, endData: { root: Array.from({ length: 7 }, (_, id) => ({
      nodeId: id, x: id * 5, y: id * 10, width: 852, height: 26
    })) } }
  };
  const privateTiming = {
    cat: "blink.user_timing",
    name: "private-user-timing \" braces ][{} \\ emoji 😀",
    ph: "I",
    pid: 120,
    tid: 141,
    ts: 2_840
  };
  const compositor = { ...compound, cat: "cc,private-category", name: "Commit" };
  const dropped = { ...compound, cat: "private-category" };
  const eventPairsPerBatch = 512;
  const batch = `${JSON.stringify(compositor)},\n${JSON.stringify(dropped)},\n`.repeat(eventPairsPerBatch);
  const limit = 288 * 1024 * 1024;
  const header = '{"traceEvents":[\n';
  const tail = `${JSON.stringify(compound)},${JSON.stringify(privateTiming)}],"metadata":{"private":"private-metadata"}}`;
  const batches = Math.floor((limit - Buffer.byteLength(header + tail)) / Buffer.byteLength(batch));
  const padding = limit - Buffer.byteLength(header + tail) - batches * Buffer.byteLength(batch);
  let rawPath: string | undefined;
  let mono = 0;
  try {
    // Generate the fixture before the stop deadline starts. The fake backend
    // hands off an existing file, while the real worker still reads all bytes.
    const fixture = join(directory, "native-fixture.json");
    const raw = await open(fixture, "w");
    try {
      await raw.write(header);
      for (let index = 0; index < batches; index++) await raw.write(batch);
      await raw.write(tail);
      await raw.write(" ".repeat(padding));
      expect((await raw.stat()).size).toBe(limit);
    } finally {
      await raw.close();
    }
    const trace = new ChromiumTrace(() => ({
      async startRecording() {},
      async stopRecording(file = "") {
        rawPath = file;
        await rename(fixture, file);
        return file;
      }
    }), () => {}, { monotonicNow: () => ++mono });

    await trace.setArmed(true);
    const result = await trace.capture(output, ++mono);
    expect(result).toMatchObject({ status: "written", rawBytes: limit, rawLimitBytes: limit });
    const projectedCommit = { pid: 120, tid: 141, cat: "cc", name: "Commit", ph: "X", ts: 2_010, dur: 830 };
    const projectedTail = [
      { pid: 120, tid: 141, cat: "devtools.timeline", name: "Layout", ph: "X", ts: 2_010, dur: 830 },
      { pid: 120, tid: 141, cat: "blink.user_timing", name: "User timing", ph: "I", ts: 2_840, s: "t" }
    ].map((event) => JSON.stringify(event)).join(",");
    const projectedBatch = `${JSON.stringify(projectedCommit)},`.repeat(eventPairsPerBatch);
    const expectedHash = createHash("sha256").update('{"traceEvents":[');
    for (let index = 0; index < batches; index++) expectedHash.update(projectedBatch);
    expectedHash.update(`${projectedTail}]}`);
    const actualHash = createHash("sha256");
    for await (const chunk of createReadStream(output)) actualHash.update(chunk);
    expect(actualHash.digest("hex")).toBe(expectedHash.digest("hex"));
    await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual(["trace.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);


it("reports measured and allowed bytes when a raw export is over budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-budget-"));
  const output = join(directory, "trace.json");
  let mono = 0;
  let rawPath: string | undefined;
  const limit = 288 * 1024 * 1024;
  const trace = new ChromiumTrace(() => ({
    async startRecording() {},
    async stopRecording(file = "") {
      rawPath = file;
      await writeFile(file, "");
      await truncate(file, limit + 1);
      return file;
    }
  }), () => {}, { monotonicNow: () => ++mono });
  try {
    await trace.setArmed(true);
    // The size limit applies as soon as the native export finishes, even if
    // the CPU profile is still recording and hasn't authorized publication.
    const waitingForProfile = () => new Promise<never>(() => {});
    await expect(trace.capture(output, ++mono, waitingForProfile)).rejects.toThrow(
      `Chromium trace exceeded the export size limit (${limit + 1} raw bytes, ${limit} byte limit)`
    );
    await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("discards malformed and timed-out exports and releases the recording queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-filter-failure-"));
  const output = join(directory, "trace.json");
  let rawPath: string | undefined;
  let mono = 0;
  const options = { monotonicNow: () => ++mono, filterTimeoutMs: 500, workerModule: stalledWorker };
  let malformed = false;
  let nativeStarts = 0;
  const trace = new ChromiumTrace(() => ({
    async startRecording() { nativeStarts++; },
    async stopRecording(file = "") {
      rawPath = file;
      await writeFile(file, malformed ? '{"traceEvents":[{"name":private-invalid-data}]}' : emptyTrace);
      return file;
    }
  }), () => {}, options);
  try {
    await trace.setArmed(true);
    const capture = trace.capture(output, ++mono);
    await trace.setArmed(true);
    expect(nativeStarts).toBe(1);
    await expect(capture).rejects.toThrow(/Filtering Chromium trace timed out.*raw bytes/);
    await trace.setArmed(true);
    expect(nativeStarts).toBe(2);
    await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([]);

    options.workerModule = new URL("./chromium-trace-worker.ts", import.meta.url);
    malformed = true;
    const failure = await trace.capture(output, ++mono).catch((error: Error) => error.message);
    expect(failure).toMatch(/^Chromium trace contains invalid JSON .*raw bytes/);
    expect(failure).not.toContain("private-invalid-data");
    await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["disarm", "hurried shutdown"] as const)("discards a filter already in progress on %s", async (stop) => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-filter-shutdown-"));
  let rawPath: string | undefined;
  let mono = 0;
  const trace = new ChromiumTrace(() => ({
    async startRecording() {},
    async stopRecording(file = "") {
      rawPath = file;
      await writeFile(file, emptyTrace);
      return file;
    }
  }), () => {}, { monotonicNow: () => ++mono, workerModule: stalledWorker });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let result: Promise<unknown> | undefined;
  let disarm: Promise<void> | undefined;
  try {
    await trace.setArmed(true);
    result = trace.capture(join(directory, "trace.json"), ++mono).catch((error: Error) => error);
    await waitForPartialExport(directory);
    if (stop === "hurried shutdown") trace.beginShutdown(9_000);
    await vi.advanceTimersByTimeAsync(5_001);
    if (stop === "hurried shutdown") {
      trace.beginShutdown(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
    } else {
      disarm = trace.setArmed(false);
    }
    await vi.waitFor(async () => {
      await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 500 });
    const expected = stop === "disarm" ? { status: "skipped", reason: "canceled" }
      : { message: expect.stringMatching(/Chromium trace timed out during shutdown/i) };
    expect(await result).toMatchObject(expected);
    await disarm;
    await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    await result;
    await disarm;
    await rm(directory, { recursive: true, force: true });
  }
});

it("projects oversized redacted fields like their small equivalents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-event-oracle-"));
  // Escaped quotes, controls and Unicode cross read chunks throughout the value.
  const large = 'private "label" \\ {}[] \n 😀 '.repeat(400_000);
  const lineage = "PwrGit Lineage publish repo-change view=1 target=2";
  const fixture = (privateData: string) => JSON.stringify({
    traceEvents: [
      { pid: 2, tid: 3, ts: 10, ph: "I", cat: `${privateData},blink.user_timing`, name: privateData },
      { pid: 2, tid: 3, ts: 11, ph: "R", cat: "blink.user_timing", name: lineage, args: { omitted: privateData } },
      { pid: 2, tid: 3, ts: 12, ph: "R", cat: "blink.user_timing", name: `${lineage} ${privateData}` },
      { pid: 2, tid: 3, ph: "M", name: "thread_name", args: { omitted: { nested: [privateData] }, name: "CrRendererMain" } },
      { pid: 2, tid: 3, ts: 20, ph: "X", cat: "devtools.timeline", name: "Layout", dur: 5 }
    ],
    metadata: { omitted: privateData }
  });
  let mono = 0;
  let raw = "";
  const trace = new ChromiumTrace(() => ({
    async startRecording() {},
    async stopRecording(file = "") {
      await writeFile(file, raw);
      return file;
    }
  }), () => {}, { monotonicNow: () => ++mono });
  try {
    async function capture(privateData: string, basename: string): Promise<unknown> {
      raw = fixture(privateData);
      const output = join(directory, basename);
      await trace.setArmed(true);
      await expect(trace.capture(output, ++mono)).resolves.toMatchObject({ status: "written" });
      return JSON.parse(await readFile(output, "utf8"));
    }
    const expected = await capture("synthetic", "small.json");
    expect(expected).toEqual({ traceEvents: [
      { pid: 2, tid: 3, ts: 10, ph: "I", cat: "blink.user_timing", name: "User timing", s: "t" },
      { pid: 2, tid: 3, ts: 11, ph: "R", cat: "blink.user_timing", name: lineage },
      { pid: 2, tid: 3, ts: 12, ph: "R", cat: "blink.user_timing", name: "User timing" },
      { pid: 2, tid: 3, ph: "M", cat: "__metadata", name: "thread_name", args: { name: "CrRendererMain" } },
      { pid: 2, tid: 3, ts: 20, ph: "X", cat: "devtools.timeline", name: "Layout", dur: 5 }
    ] });
    expect(await capture(large, "large.json")).toEqual(expected);
    raw = '{"traceEvents":[{"omitted":"' + "x".repeat(128 * 1024) + '\\q"}]}';
    await trace.setArmed(true);
    await expect(trace.capture(join(directory, "invalid.json"), ++mono)).rejects.toThrow(
      /^Chromium trace contains invalid JSON/
    );
    expect((await readdir(directory)).sort()).toEqual(["large.json", "small.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
