import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendResourceSample } from "./resource-monitor";

vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, powerMonitor: {} }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

describe("resource sample retention", () => {
  it("appends samples, retains the full last day, and removes only its older hourly files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pwrgit-resources-"));
    try {
      await writeFile(join(directory, "resource-usage-2026-11-13T15.ndjson"), "old\n");
      await writeFile(join(directory, "resource-usage-2026-11-14T16.ndjson"), "retain\n");
      await writeFile(join(directory, "other.ndjson"), "unrelated\n");
      const at = new Date("2026-11-15T16:59:00Z");
      await appendResourceSample(directory, at, { n: 1 });
      await appendResourceSample(directory, at, { n: 2 });
      expect((await readdir(directory)).sort()).toEqual([
        "other.ndjson", "resource-usage-2026-11-14T16.ndjson", "resource-usage-2026-11-15T16.ndjson"
      ]);
      expect(await readFile(join(directory, "resource-usage-2026-11-15T16.ndjson"), "utf8")).toBe('{"n":1}\n{"n":2}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
