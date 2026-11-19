import { Dir, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { logMain } from "../logs";
import { directorySize, directorySizeInWorker } from "./dir-size";
import { runPruneSizeWorker } from "./prune-size-scan";

vi.mock("../logs", () => ({ logMain: vi.fn() }));

const entry = new URL("./prune-size-worker.ts", import.meta.url);
let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "pwrgit-prune-size-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("matches filesystem metadata for generated trees and returns lower bounds at entry caps", async () => {
  let next = 0;
  const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  await runPruneSizeWorker(entry, new AbortController().signal, async (measure) => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        size: fc.integer({ min: 0, max: 128 }),
        modified: fc.integer({ min: 0, max: 1_000 })
      }), { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 0, max: 45 }),
      async (files, entryCap) => {
        const checkout = join(root, String(next++));
        const ignored = join(checkout, "node_modules");
        mkdirSync(ignored, { recursive: true });
        const paths = files.map(({ size, modified }, index) => {
          const path = join(ignored, String(index));
          writeFileSync(path, Buffer.alloc(size));
          const future = 2_000_000_000 + modified;
          utimesSync(path, future, future);
          return path;
        });
        const hardLink = join(checkout, "hard-link");
        const symlink = join(checkout, "loop");
        linkSync(paths[0]!, hardLink);
        symlinkSync(checkout, symlink, process.platform === "win32" ? "junction" : "dir");
        const stats = [checkout, ignored, hardLink, symlink, ...paths].map((path) => lstatSync(path));
        const latest = Math.max(...stats.flatMap((s) => [s.mtimeMs, s.ctimeMs, s.birthtimeMs]));
        const expected = {
          bytes: files.reduce((sum, { size }) => sum + size, 0),
          entries: files.length + 3,
          hardLinks: 1,
          inaccessible: 0,
          partial: false,
          lastTouchedAt: new Date(latest).toISOString()
        };
        expect(await measure(checkout)).toEqual(expected);
        const capped = await directorySizeInWorker(checkout, flag, entryCap);
        if (entryCap > expected.entries) {
          expect(capped).toEqual(expected);
        } else {
          // Directory handles enumerate in filesystem order, so a truncated
          // traversal may include a different subset of entries.
          expect(capped.entries).toBe(entryCap);
          expect(capped.bytes).toBeLessThanOrEqual(expected.bytes);
          expect(capped.partial).toBe(entryCap < expected.entries);
        }
      }
    ), { numRuns: 25 });
  });
  expect(logMain).not.toHaveBeenCalled();
});

it("bounds directory reads at the entry cap and closes the handle when cancelled during enumeration", async () => {
  for (let index = 0; index < 50; index += 1) {
    writeFileSync(join(root, String(index)), "file");
  }
  const read = Dir.prototype.readSync;
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 16 }),
    fc.boolean(),
    async (limit, cancel) => {
      const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      let reads = 0;
      const readSpy = vi.spyOn(Dir.prototype, "readSync").mockImplementation(function (this: Dir) {
        const entry = read.call(this);
        reads += 1;
        if (cancel && reads === limit) Atomics.store(flag, 0, 1);
        return entry;
      });
      const closeSpy = vi.spyOn(Dir.prototype, "closeSync");
      try {
        const result = await directorySizeInWorker(root, flag, cancel ? 50 : limit);
        expect(result.partial).toBe(true);
        expect(result.entries).toBeLessThanOrEqual(limit);
        expect(reads).toBe(cancel ? limit : limit + 1);
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        readSpy.mockRestore();
        closeSpy.mockRestore();
      }
    }
  ));
});

it("starts the file-backed worker from its loaded module bytes", async () => {
  const modulePath = join(root, "worker.mjs");
  writeFileSync(modulePath, `
    import { parentPort } from "node:worker_threads";
    parentPort.once("message", () => {
      parentPort.postMessage({ bytes: import.meta.url.startsWith("data:") ? 1 : 0 });
    });
  `);
  await runPruneSizeWorker(modulePath, new AbortController().signal, async (measure) => {
    expect(await measure(root)).toMatchObject({ bytes: 1 });
  });
  expect(logMain).not.toHaveBeenCalled();
});

it("passes cancellation to a live worker and distinguishes missing directories", async () => {
  const controller = new AbortController();
  await runPruneSizeWorker(entry, controller.signal, async (measure) => {
    expect(await measure(join(root, "gone"))).toEqual({
      bytes: 0, entries: 0, hardLinks: 0, inaccessible: 1, partial: false
    });
    controller.abort();
    expect(await measure(root)).toEqual({
      bytes: 0, entries: 0, hardLinks: 0, inaccessible: 0, partial: true
    });
  });
  expect(logMain).not.toHaveBeenCalled();
});

it("falls back to the asynchronous walk when the worker cannot load", async () => {
  writeFileSync(join(root, "ignored"), "cache");
  const signal = new AbortController().signal;
  await runPruneSizeWorker(join(root, "missing-worker.mjs"), signal, async (measure) => {
    const expected = await directorySize(root, { trackActivity: true });
    expect(await measure(root)).toEqual(expected);
    expect(await measure(root)).toEqual(expected);
  });
  expect(logMain).toHaveBeenCalledTimes(1);
});
