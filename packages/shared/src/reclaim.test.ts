import { describe, expect, it } from "vitest";
import {
  excludePatternProblem,
  formatBytes,
  MAX_EXCLUDE_PATTERNS,
  normalizeExcludes,
  RECLAIM_DEFAULT_EXCLUDES
} from "./reclaim";

describe("RECLAIM_DEFAULT_EXCLUDES", () => {
  it("spares the local files a clean cannot give back", () => {
    // Every one of these is routinely gitignored and has no object in the
    // object store. The regenerable bulk is deliberately NOT in this list.
    for (const pattern of [".env*", "*.local", "*.sqlite", "*.pem"]) {
      expect(RECLAIM_DEFAULT_EXCLUDES).toContain(pattern);
    }
    for (const regenerable of ["node_modules/", "dist/", "target/", "build/"]) {
      expect(RECLAIM_DEFAULT_EXCLUDES).not.toContain(regenerable);
    }
  });

  it("survives normalization unchanged, so the default is what git is given", () => {
    expect(normalizeExcludes([...RECLAIM_DEFAULT_EXCLUDES])).toEqual([
      ...RECLAIM_DEFAULT_EXCLUDES
    ]);
  });
});

describe("excludePatternProblem", () => {
  it("refuses a negation, which reads backwards on a destructive dialog", () => {
    expect(excludePatternProblem("!node_modules")).toBe("negation");
  });

  it("refuses blanks and over-long patterns", () => {
    expect(excludePatternProblem("   ")).toBe("empty");
    expect(excludePatternProblem("x".repeat(400))).toBe("too_long");
  });

  it("accepts ordinary gitignore patterns", () => {
    for (const pattern of [".env", "*.log", "build/", "a/b/*.tmp", "[Dd]ebug/"]) {
      expect(excludePatternProblem(pattern)).toBeNull();
    }
  });
});

describe("normalizeExcludes", () => {
  it("trims, drops blanks and duplicates, and keeps the user's order", () => {
    expect(normalizeExcludes(["  .env ", "", ".env", "*.log", "  "])).toEqual([
      ".env",
      "*.log"
    ]);
  });

  it("drops refused patterns rather than passing them to git", () => {
    expect(normalizeExcludes(["!keep", "*.log"])).toEqual(["*.log"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_EXCLUDE_PATTERNS + 20 }, (_, i) => `p${i}`);
    expect(normalizeExcludes(many)).toHaveLength(MAX_EXCLUDE_PATTERNS);
  });
});

describe("formatBytes", () => {
  it("rounds one way for every surface that reports a size", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 3.25)).toBe("3.3 MB");
    expect(formatBytes(1024 ** 3 * 2)).toBe("2 GB");
    // Three digits drop the decimal, so a column of sizes stays narrow.
    expect(formatBytes(1024 * 512)).toBe("512 KB");
  });
});
