import { mkdtemp, open, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { ChromiumTrace } from "./chromium-trace";

const emptyTrace = JSON.stringify({ traceEvents: [] });

it("assigns each rolling trace to at most one overlapping capture across clock adjustments", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.tuple(fc.integer({ min: 2, max: 5 }), fc.integer({ min: 1, max: 1000 })), { minLength: 1, maxLength: 12 }),
    async (rounds) => {
      const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-model-"));
      try {
        let mono = 0;
        let wall = 100_000;
        let nativeRecording = false;
        const unexpectedErrors: unknown[] = [];
        const trace = new ChromiumTrace(() => ({
          async startRecording() {
            expect(nativeRecording).toBe(false);
            nativeRecording = true;
          },
          async stopRecording(file = join(directory, "discard.json")) {
            expect(nativeRecording).toBe(true);
            await writeFile(file, emptyTrace);
            nativeRecording = false;
            return file;
          }
        }), (_message, error) => unexpectedErrors.push(error), {
          wallNow: () => wall,
          monotonicNow: () => ++mono
        });

        const saved: string[] = [];
        for (const [index, [count, rollback]] of rounds.entries()) {
          await Promise.all([trace.setArmed(true), trace.setArmed(true)]);
          expect(nativeRecording).toBe(true);
          const trigger = ++mono;
          wall -= rollback;
          const names = Array.from({ length: count }, (_, i) => `capture-${index}-${i}.json`);
          // Request a fresh recording behind the first export, before the
          // other already-triggered windows get their turns to export.
          const captures = await Promise.all([
            trace.capture(join(directory, names[0]!), trigger),
            trace.setArmed(true),
            ...names.slice(1).map((name) => trace.capture(join(directory, name), trigger))
          ]);
          expect(captures.filter((result) => result?.status === "written")).toHaveLength(1);
          expect(captures[0]?.status).toBe("written");
          saved.push(names[0]!);
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


it("publishes the allowlisted projection of a trace larger than the former 96 MiB limit", async () => {
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
    args: { beginData: { frame: "private-layout-frame" }, endData: { root: Array.from({ length: 128 }, (_, id) => ({
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
  const dropped = { ...compound, cat: "private-category" };
  const eventsPerBatch = 256;
  const batch = Array.from({ length: eventsPerBatch }, () => `${JSON.stringify(dropped)},\n`).join("");
  const batches = Math.ceil((97 * 1024 * 1024) / Buffer.byteLength(batch));
  let rawPath: string | undefined;
  let rawBytes = 0;
  let mono = 0;
  try {
    const trace = new ChromiumTrace(() => ({
      async startRecording() {},
      async stopRecording(file = "") {
        rawPath = file;
        const raw = await open(file, "w");
        try {
          await raw.write('{"traceEvents":[\n');
          for (let index = 0; index < batches; index++) await raw.write(batch);
          await raw.write(`${JSON.stringify(compound)},${JSON.stringify(privateTiming)}],
            "metadata": {"private": "private-metadata"} }`);
          rawBytes = (await raw.stat()).size;
        } finally {
          await raw.close();
        }
        return file;
      }
    }), () => {}, { monotonicNow: () => ++mono });

    await trace.setArmed(true);
    const result = await trace.capture(output, ++mono);
    expect(result).toMatchObject({ status: "written", rawBytes, rawLimitBytes: 256 * 1024 * 1024 });
    expect(rawBytes).toBeGreaterThan(96 * 1024 * 1024);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ traceEvents: [
      { cat: "devtools.timeline", name: "Layout", ph: "X", pid: 120, tid: 141, ts: 2_010, dur: 830 },
      { cat: "blink.user_timing", name: "User timing", ph: "I", pid: 120, tid: 141, ts: 2_840, s: "t" }
    ] });
    await expect(stat(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual(["trace.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);


it("reports measured and allowed bytes when a raw export is over budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-budget-"));
  const output = join(directory, "trace.json");
  let mono = 0;
  let rawPath: string | undefined;
  const limit = 256 * 1024 * 1024;
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
    await expect(trace.capture(output, ++mono)).rejects.toThrow(
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
  const stalledWorker = new URL(`data:text/javascript,${encodeURIComponent(`
    import { workerData } from "node:worker_threads";
    import { writeFileSync } from "node:fs";
    writeFileSync(workerData.filteredPath, '{"traceEvents":[');
    setInterval(() => {}, 1_000);
  `)}`);
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
    const rearm = trace.setArmed(true);
    await expect(capture).rejects.toThrow(/Filtering Chromium trace timed out.*raw bytes/);
    await rearm;
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
