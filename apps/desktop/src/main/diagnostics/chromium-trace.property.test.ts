import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { ChromiumTrace } from "./chromium-trace";

it("assigns each rolling trace to at most one overlapping capture", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.tuple(fc.integer({ min: 1, max: 5 }), fc.boolean()), { minLength: 1, maxLength: 15 }),
    async (rounds) => {
      const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-model-"));
      try {
        let now = 1;
        let nativeRecording = false;
        const unexpectedErrors: unknown[] = [];
        const trace = new ChromiumTrace(() => ({
          async startRecording(config) {
            expect(nativeRecording).toBe(false);
            expect(config).toMatchObject({ recording_mode: "record-continuously" });
            nativeRecording = true;
          },
          async stopRecording(file = join(directory, "discard.json")) {
            expect(nativeRecording).toBe(true);
            await writeFile(file, "{}");
            nativeRecording = false;
            return file;
          }
        }), (_message, error) => unexpectedErrors.push(error), () => now);

        const saved: string[] = [];
        for (const [index, [count, rearm]] of rounds.entries()) {
          await Promise.all([trace.setArmed(true), trace.setArmed(true)]);
          expect(nativeRecording).toBe(true);
          const trigger = ++now;
          now++;
          const names = Array.from({ length: count }, (_, i) => `capture-${index}-${i}.json`);
          const captures = await Promise.all(names.map((name) =>
            trace.capture(join(directory, name), trigger, () => rearm)
          ));
          expect(captures.filter((result) => result.status === "written")).toHaveLength(1);
          expect(captures[0]?.status).toBe("written");
          saved.push(names[0]!);
          expect(nativeRecording).toBe(rearm);
          now++;
        }
        await Promise.all([trace.setArmed(false), trace.setArmed(false)]);
        expect(nativeRecording).toBe(false);
        expect(unexpectedErrors).toEqual([]);
        expect((await readdir(directory)).sort()).toEqual(saved.sort());
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  ), { numRuns: 35 });
});
