import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logMain: vi.fn() }));
vi.mock("../logs", () => ({ logMain: mocks.logMain }));

import { AcpModelCache, type AcpModelCacheEntry } from "./acp-model-cache";

const roots: string[] = [];

afterEach(() => {
  mocks.logMain.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-acp-models-"));
  roots.push(dir);
  return join(dir, "acp-models.json");
}

function entry(command: string, ...models: AcpModelCacheEntry["models"]): AcpModelCacheEntry {
  return { models, command, discoveredAt: "2026-09-19T12:00:00.000Z" };
}

describe("AcpModelCache", () => {
  it("serves an agent's list saved by an earlier process", () => {
    const file = cacheFile();
    const saved = entry("/usr/local/bin/grok", { id: "grok-4", label: "Grok 4", isDefault: true });
    new AcpModelCache(file).save("grok", saved);

    expect(new AcpModelCache(file).load("grok")).toEqual(saved);
  });

  it("replaces one agent's list and keeps the others'", () => {
    const file = cacheFile();
    const cache = new AcpModelCache(file);
    cache.save("grok", entry("/bin/grok", { id: "grok-3", label: "Grok 3" }));
    cache.save("qwen", entry("/bin/qwen", { id: "qwen3-coder", label: "Qwen3 Coder" }));
    cache.save("grok", entry("/opt/grok", { id: "grok-4", label: "Grok 4" }));

    const reopened = new AcpModelCache(file);
    expect(reopened.load("grok")).toEqual(entry("/opt/grok", { id: "grok-4", label: "Grok 4" }));
    expect(reopened.load("qwen")?.models.map((m) => m.id)).toEqual(["qwen3-coder"]);
  });

  it("treats a missing file as an empty cache without creating one", () => {
    const file = cacheFile();
    expect(new AcpModelCache(file).load("grok")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("treats a corrupt file as an empty cache, and the next save replaces it", () => {
    const file = cacheFile();
    writeFileSync(file, "\u0000garbage", "utf8");
    const cache = new AcpModelCache(file);
    expect(cache.load("kimi")).toBeUndefined();

    cache.save("kimi", entry("/bin/kimi", { id: "k2", label: "K2" }));
    expect(new AcpModelCache(file).load("kimi")?.models).toEqual([{ id: "k2", label: "K2" }]);
  });

  it("ignores a file written in another cache format", () => {
    const file = cacheFile();
    writeFileSync(
      file,
      JSON.stringify({ version: 99, agents: { grok: entry("/bin/grok", { id: "g", label: "G" }) } })
    );
    expect(new AcpModelCache(file).load("grok")).toBeUndefined();
  });

  it("drops an entry whose shape it cannot rely on, and keeps the rest", () => {
    const file = cacheFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        agents: { grok: { command: "/bin/grok" }, qwen: entry("/bin/qwen", { id: "q", label: "Q" }) }
      })
    );
    const cache = new AcpModelCache(file);

    // `entry.models` is read straight off a loaded entry, so a row without one
    // has to read as a miss rather than throw where it is used.
    expect(cache.load("grok")).toBeUndefined();
    expect(cache.load("qwen")?.models).toEqual([{ id: "q", label: "Q" }]);
    expect(cache.findLabel("q")).toBe("Q");
  });

  it("leaves no temp file beside the cache", () => {
    const file = cacheFile();
    new AcpModelCache(file).save("grok", entry("/bin/grok"));
    expect(readdirSync(dirname(file))).toEqual(["acp-models.json"]);
  });

  it("logs a failed write instead of throwing, and does not pretend it landed", () => {
    const blocker = cacheFile();
    writeFileSync(blocker, "");
    const cache = new AcpModelCache(join(blocker, "acp-models.json"));

    expect(() => cache.save("grok", entry("/bin/grok", { id: "g", label: "G" }))).not.toThrow();
    expect(cache.load("grok")).toBeUndefined();
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "ai",
      "failed to persist ACP model cache",
      expect.objectContaining({ agentId: "grok", message: expect.any(String) })
    );
  });

  describe("findLabel", () => {
    it("names a recorded model id without knowing which agent produced it", () => {
      const cache = new AcpModelCache(cacheFile());
      cache.save("grok", entry("/bin/grok", { id: "grok-4", label: "Grok 4" }));
      cache.save("qwen", entry("/bin/qwen", { id: "qwen3-coder", label: "Qwen3 Coder" }));
      expect(cache.findLabel("qwen3-coder")).toBe("Qwen3 Coder");
    });

    it("answers undefined for an unknown id, an empty id, or an empty label", () => {
      const cache = new AcpModelCache(cacheFile());
      cache.save("grok", entry("/bin/grok", { id: "grok-4", label: "" }, { id: "", label: "Blank" }));
      expect(cache.findLabel("grok-4")).toBeUndefined();
      expect(cache.findLabel("")).toBeUndefined();
      expect(cache.findLabel("grok-5")).toBeUndefined();
    });
  });
});
