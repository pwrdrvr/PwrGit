import { describe, expect, it, vi } from "vitest";
import { ok, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  createFileListCache,
  FILE_LIST_TTL_MS,
  rankFilePaths
} from "./file-search";

const PATHS = [
  "apps/desktop/src/renderer/src/App.tsx",
  "apps/desktop/src/renderer/src/features/diff/DiffPane.tsx",
  "apps/desktop/src/renderer/src/features/diff/FileInsightsPane.tsx",
  "apps/desktop/src/legacy/vendor/App.tsx",
  "README.md",
  "packages/shared/src/types.ts"
];

describe("rankFilePaths", () => {
  it("puts an exact filename first and breaks ties on the shorter path", () => {
    expect(rankFilePaths(PATHS, "App.tsx", 10).map((h) => h.path)).toEqual([
      "apps/desktop/src/renderer/src/App.tsx",
      "apps/desktop/src/legacy/vendor/App.tsx"
    ]);
  });

  it("matches a path fragment, so a directory finds what is under it", () => {
    expect(rankFilePaths(PATHS, "features/diff", 10).map((h) => h.name)).toEqual([
      "DiffPane.tsx",
      "FileInsightsPane.tsx"
    ]);
  });

  it("matches a path pasted from a shell prompt end-first", () => {
    expect(
      rankFilePaths(PATHS, "renderer/src/App.tsx", 10).map((h) => h.path)
    ).toEqual(["apps/desktop/src/renderer/src/App.tsx"]);
  });

  it("splits the row's name and directory", () => {
    expect(rankFilePaths(PATHS, "README.md", 10)).toEqual([
      { path: "README.md", name: "README.md", dir: "" }
    ]);
    expect(rankFilePaths(PATHS, "types.ts", 10)[0]).toEqual({
      path: "packages/shared/src/types.ts",
      name: "types.ts",
      dir: "packages/shared/src"
    });
  });

  it("stays substring-only so a short query cannot hit the whole repo", () => {
    // "asx" is a subsequence of several of these paths and a substring of none.
    expect(rankFilePaths(PATHS, "asx", 10)).toEqual([]);
  });

  it("returns nothing for an empty query and honours the limit", () => {
    expect(rankFilePaths(PATHS, "   ", 10)).toEqual([]);
    expect(rankFilePaths(PATHS, "tsx", 2)).toHaveLength(2);
  });
});

describe("createFileListCache", () => {
  const listing = (paths: string[]): GitExec =>
    vi.fn(
      (): Promise<Result<GitOutput>> =>
        Promise.resolve(
          ok({ stdout: paths.map((p) => `${p}\0`).join(""), stderr: "", exitCode: 0 })
        )
    );

  it("re-reads only after the TTL lapses", async () => {
    let clock = 1_000;
    const cache = createFileListCache(() => clock);
    const git = listing(["a.txt", "b.txt"]);

    expect(await cache.paths(git, "wt-1", "/repo")).toEqual(ok(["a.txt", "b.txt"]));
    expect(await cache.paths(git, "wt-1", "/repo")).toEqual(ok(["a.txt", "b.txt"]));
    expect(git).toHaveBeenCalledTimes(1);

    clock += FILE_LIST_TTL_MS + 1;
    expect(await cache.paths(git, "wt-1", "/repo")).toEqual(ok(["a.txt", "b.txt"]));
    expect(git).toHaveBeenCalledTimes(2);
  });

  it("keeps a bounded number of worktrees", async () => {
    const cache = createFileListCache(() => 0);
    const git = listing(["a.txt"]);
    for (const id of ["wt-1", "wt-2", "wt-3", "wt-4"]) {
      await cache.paths(git, id, "/repo");
    }
    expect(cache.size()).toBe(3);
  });
});
