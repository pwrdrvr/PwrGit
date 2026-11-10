import fc from "fast-check";
import { expect, it } from "vitest";
import { err, ok } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { createFileListCache, rankIndexedPaths } from "./file-search";

// Model: superseded queries may be canceled; every remaining live reader
// must receive the tracked file list, with at most one Git read per worktree.
it("model: live readers recover when a shared ls-files owner is superseded", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.integer({ min: 2, max: 10 }), async (scheduler, count) => {
    const cache = createFileListCache();
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const git: GitExec = () => {
      calls++;
      maximum = Math.max(maximum, ++active);
      const answer = calls === 1
        ? err({ kind: "git" as const, code: "aborted", message: "Superseded query" })
        : ok({ stdout: "README.md\0docs/stable.md\0", stderr: "", exitCode: 0 });
      return scheduler.schedule(Promise.resolve(answer), `ls-files ${calls}`).then((result) => {
        active--;
        return result;
      });
    };
    let previous: AbortController | undefined;
    const reads = [];
    for (let at = 0; at < count; at++) {
      previous?.abort();
      previous = new AbortController();
      reads.push(cache.index(git, "worktree", "/repo", previous.signal));
    }
    // Another window can share the read without superseding this renderer.
    reads.push(cache.index(git, "worktree", "/repo"));
    const results = await scheduler.waitFor(Promise.all(reads));
    for (const result of results.slice(-2)) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(rankIndexedPaths(result.value, "docs/stable.md", 8)).toEqual([
        { path: "docs/stable.md", name: "stable.md", dir: "docs" }
      ]);
    }
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    const cached = await cache.index(git, "worktree", "/repo");
    expect(cached.ok).toBe(true);
    expect(calls).toBe(2);
  }));
});
