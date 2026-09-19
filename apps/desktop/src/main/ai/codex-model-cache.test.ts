import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexModelOption } from "@pwrgit/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logMain: vi.fn() }));
vi.mock("../logs", () => ({ logMain: mocks.logMain }));

import { CodexModelCache, codexModelCacheKey, type CodexModelCacheEntry } from "./codex-model-cache";

const roots: string[] = [];

afterEach(() => {
  mocks.logMain.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-codex-models-"));
  roots.push(dir);
  return dir;
}

function model(id: string, displayName = id): CodexModelOption {
  return {
    id,
    model: id,
    displayName,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    isDefault: false
  };
}

function entry(...models: CodexModelOption[]): CodexModelCacheEntry {
  return { models, discoveredAt: "2026-09-19T12:00:00.000Z" };
}

const key = (n: number): string => codexModelCacheKey(`/bin/codex-${n}`, `/home/me/.codex-${n}`);

describe("codexModelCacheKey", () => {
  it("keeps binary and account apart even when a path contains the obvious separator", () => {
    expect(codexModelCacheKey("/opt/a,b", "/home/c")).not.toBe(
      codexModelCacheKey("/opt/a", "b,/home/c")
    );
  });
});

describe("CodexModelCache", () => {
  it("serves a list saved by an earlier process", () => {
    const file = join(tempDir(), "codex-models.json");
    const saved = entry(model("gpt-5", "GPT-5"));
    new CodexModelCache(file).save(key(1), saved);

    expect(new CodexModelCache(file).load(key(1))).toEqual(saved);
  });

  it("keeps each binary + account pair's list separately", () => {
    const file = join(tempDir(), "codex-models.json");
    const cache = new CodexModelCache(file);
    cache.save(key(1), entry(model("gpt-5")));
    cache.save(key(2), entry(model("gpt-5-mini")));

    const reopened = new CodexModelCache(file);
    expect(reopened.load(key(1))?.models.map((m) => m.id)).toEqual(["gpt-5"]);
    expect(reopened.load(key(2))?.models.map((m) => m.id)).toEqual(["gpt-5-mini"]);
  });

  it("treats a missing file as an empty cache without creating one", () => {
    const file = join(tempDir(), "codex-models.json");
    const cache = new CodexModelCache(file);
    expect(cache.load(key(1))).toBeUndefined();
    expect(cache.findLabel("gpt-5")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("treats a corrupt file as an empty cache, and the next save replaces it", () => {
    const file = join(tempDir(), "codex-models.json");
    writeFileSync(file, "{ not json", "utf8");
    const cache = new CodexModelCache(file);
    expect(cache.load(key(1))).toBeUndefined();

    cache.save(key(1), entry(model("gpt-5")));
    expect(new CodexModelCache(file).load(key(1))?.models).toHaveLength(1);
  });

  it("ignores a file written in another cache format", () => {
    const file = join(tempDir(), "codex-models.json");
    writeFileSync(file, JSON.stringify({ version: 2, lists: { [key(1)]: entry(model("x")) } }));
    expect(new CodexModelCache(file).load(key(1))).toBeUndefined();
  });

  it("creates its directory and leaves no temp file behind", () => {
    const dir = tempDir();
    const file = join(dir, "cache", "codex-models.json");
    new CodexModelCache(file).save(key(1), entry(model("gpt-5")));
    expect(readdirSync(join(dir, "cache"))).toEqual(["codex-models.json"]);
  });

  it("logs a failed write instead of throwing, and does not pretend it landed", () => {
    const dir = tempDir();
    // A regular file where the cache directory should be: mkdir must fail.
    writeFileSync(join(dir, "blocker"), "");
    const cache = new CodexModelCache(join(dir, "blocker", "codex-models.json"));

    expect(() => cache.save(key(1), entry(model("gpt-5")))).not.toThrow();
    expect(cache.load(key(1))).toBeUndefined();
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "ai",
      "failed to persist Codex model cache",
      expect.objectContaining({ message: expect.any(String) })
    );
  });

  describe("findLabel", () => {
    it("names a model from whichever list knows it", () => {
      const cache = new CodexModelCache(join(tempDir(), "codex-models.json"));
      cache.save(key(1), entry(model("gpt-5", "GPT-5")));
      cache.save(key(2), entry(model("gpt-5-mini", "GPT-5 mini")));
      expect(cache.findLabel("gpt-5-mini")).toBe("GPT-5 mini");
    });

    it("answers undefined when the only name known is the id itself", () => {
      // The caller already falls back to the id; a "label" equal to it would
      // only hide that the name is unknown.
      const cache = new CodexModelCache(join(tempDir(), "codex-models.json"));
      cache.save(key(1), entry(model("gpt-5"), model("o4", "")));
      expect(cache.findLabel("gpt-5")).toBeUndefined();
      expect(cache.findLabel("o4")).toBeUndefined();
    });

    it("answers undefined for an unknown or empty id", () => {
      const cache = new CodexModelCache(join(tempDir(), "codex-models.json"));
      cache.save(key(1), entry(model("", "Nameless"), model("gpt-5", "GPT-5")));
      expect(cache.findLabel("")).toBeUndefined();
      expect(cache.findLabel("gpt-6")).toBeUndefined();
    });
  });

  describe("eviction", () => {
    it("keeps the eight most recently listed pairs and drops the oldest", () => {
      const file = join(tempDir(), "codex-models.json");
      const cache = new CodexModelCache(file);
      for (let n = 0; n < 9; n += 1) cache.save(key(n), entry(model(`m-${n}`)));

      const reopened = new CodexModelCache(file);
      expect(reopened.load(key(0))).toBeUndefined();
      for (let n = 1; n < 9; n += 1) expect(reopened.load(key(n))).toBeDefined();
    });

    it("counts a re-listed pair as recent, so switching accounts back stays cached", () => {
      const file = join(tempDir(), "codex-models.json");
      const cache = new CodexModelCache(file);
      for (let n = 0; n < 8; n += 1) cache.save(key(n), entry(model(`m-${n}`)));
      cache.save(key(0), entry(model("m-0-again")));
      cache.save(key(8), entry(model("m-8")));

      const reopened = new CodexModelCache(file);
      expect(reopened.load(key(0))?.models[0]?.id).toBe("m-0-again");
      expect(reopened.load(key(1))).toBeUndefined();
      expect(reopened.load(key(8))).toBeDefined();
    });
  });
});
