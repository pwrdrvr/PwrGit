import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
