import { describe, expect, it, vi } from "vitest";
import { ok, type Result } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import {
  createFileListCache,
  FILE_LIST_TTL_MS,
  indexFilePaths,
  rankIndexedPaths
} from "./file-search";

const PATHS = [
  "apps/desktop/src/renderer/src/App.tsx",
  "apps/desktop/src/renderer/src/features/diff/DiffPane.tsx",
  "apps/desktop/src/renderer/src/features/diff/FileInsightsPane.tsx",
  "apps/desktop/src/legacy/vendor/App.tsx",
  "README.md",
  "packages/shared/src/types.ts"
];

// Built once, exactly as the cache holds it — the ranking loop never folds case.
const INDEX = indexFilePaths(PATHS);
const rank = (query: string, limit = 10) =>
  rankIndexedPaths(INDEX, query, limit);

describe("rankIndexedPaths", () => {
  it("puts an exact filename first and breaks ties on the shorter path", () => {
    expect(rank("App.tsx").map((h) => h.path)).toEqual([
      "apps/desktop/src/renderer/src/App.tsx",
      "apps/desktop/src/legacy/vendor/App.tsx"
    ]);
  });

  it("matches a path fragment, so a directory finds what is under it", () => {
    expect(rank("features/diff").map((h) => h.name)).toEqual([
      "DiffPane.tsx",
      "FileInsightsPane.tsx"
    ]);
  });

  it("matches a path pasted from a shell prompt end-first", () => {
    expect(
      rank("renderer/src/App.tsx").map((h) => h.path)
    ).toEqual(["apps/desktop/src/renderer/src/App.tsx"]);
  });

  it("splits the row's name and directory", () => {
    expect(rank("README.md")).toEqual([
      { path: "README.md", name: "README.md", dir: "" }
    ]);
    expect(rank("types.ts")[0]).toEqual({
      path: "packages/shared/src/types.ts",
      name: "types.ts",
      dir: "packages/shared/src"
    });
  });

  it("stays substring-only so a short query cannot hit the whole repo", () => {
    // "asx" is a subsequence of several of these paths and a substring of none.
    expect(rank("asx")).toEqual([]);
  });

  it("returns nothing for an empty query and honours the limit", () => {
    expect(rank("   ")).toEqual([]);
    expect(rank("tsx", 2)).toHaveLength(2);
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

  it("folds case once, when the list is read", async () => {
    const cache = createFileListCache(() => 0);
    const result = await cache.index(listing(["Src/App.TSX"]), "wt-1", "/repo");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Parallel arrays, not one object per path — `name` and `dir` are built
    // only for the rows that get returned.
    expect(result.value.paths).toEqual(["Src/App.TSX"]);
    expect(result.value.lower).toEqual(["src/app.tsx"]);
    expect([...result.value.nameStart]).toEqual([4]);
    expect(rankIndexedPaths(result.value, "app.tsx", 5)).toEqual([
      { path: "Src/App.TSX", name: "App.TSX", dir: "Src" }
    ]);
  });

  it("re-reads only after the TTL lapses", async () => {
    let clock = 1_000;
    const cache = createFileListCache(() => clock);
    const git = listing(["a.txt", "b.txt"]);

    const paths = async (): Promise<string[]> => {
      const result = await cache.index(git, "wt-1", "/repo");
      return result.ok ? result.value.paths : [];
    };

    expect(await paths()).toEqual(["a.txt", "b.txt"]);
    expect(await paths()).toEqual(["a.txt", "b.txt"]);
    expect(git).toHaveBeenCalledTimes(1);

    clock += FILE_LIST_TTL_MS + 1;
    expect(await paths()).toEqual(["a.txt", "b.txt"]);
    expect(git).toHaveBeenCalledTimes(2);
  });

  it("keeps a bounded number of worktrees", async () => {
    const cache = createFileListCache(() => 0);
    const git = listing(["a.txt"]);
    for (const id of ["wt-1", "wt-2", "wt-3", "wt-4"]) {
      await cache.index(git, id, "/repo");
    }
    expect(cache.size()).toBe(3);
  });

  it("shares one ls-files between concurrent readers of a worktree", async () => {
    let reads = 0;
    const git: GitExec = () => {
      reads += 1;
      return new Promise((resolve) =>
        queueMicrotask(() =>
          resolve(ok({ stdout: "a.txt\0b.txt\0", stderr: "", exitCode: 0 }))
        )
      );
    };
    const cache = createFileListCache(() => 0);

    const [first, second] = await Promise.all([
      cache.index(git, "wt-1", "/repo"),
      cache.index(git, "wt-1", "/repo")
    ]);

    // Two IPC messages arriving together used to spawn two Git processes.
    expect(reads).toBe(1);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.paths).toEqual(["a.txt", "b.txt"]);
  });
});
