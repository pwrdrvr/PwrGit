import fc from "fast-check";
import { expect, it } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import { sweepPrunableWorktrees } from "./worktree-prune";

function candidate(id: number): Worktree {
  return {
    id: String(id), repoId: "repo", path: `/w/${id}`, branch: `branch-${id}`,
    defaultBranch: "main", ahead: 0, behind: 0, behindDefault: 0, dirty: 0,
    mergedIntoDefault: true, divergedFromDefault: false, pinned: false,
    isDefaultBranch: false, isPrimary: false, lastActivityAt: "2000-01-01T00:00:00.000Z"
  };
}

it("reuses at most four sizing workers and closes each when the sweep ends", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 32 }),
    fc.integer({ min: 1, max: 33 }),
    fc.scheduler(),
    async (count, cancelAfter, scheduler) => {
      const repo: Repo = {
        id: "repo", name: "repo", path: "/repo", profileId: "profile", pinned: false,
        worktrees: Array.from({ length: count }, (_, index) => candidate(index))
      };
      const controller = new AbortController();
      const started = new Set<string>();
      let completed = 0;
      let opened = 0;
      let closed = 0;
      const result = await scheduler.waitFor(sweepPrunableWorktrees([{
        id: repo.id, name: repo.name, path: repo.path,
        worktreeIds: repo.worktrees.map(({ id }) => id), stateComputedAt: Date.now()
      }], {
        operationId: "sizing-workers",
        signal: controller.signal,
        computeRepoState: async () => undefined,
        readRepo: () => repo,
        runSizeWorker: async (run) => {
          opened += 1;
          try {
            await run(async (path) => {
              expect(controller.signal.aborted).toBe(false);
              expect(started.has(path)).toBe(false);
              started.add(path);
              await scheduler.schedule(Promise.resolve(), path);
              completed += 1;
              if (completed === cancelAfter) controller.abort();
              return { bytes: 1, partial: false, inaccessible: 0 };
            });
          } finally {
            closed += 1;
          }
        }
      }));
      expect(opened).toBe(Math.min(count, 4));
      expect(closed).toBe(opened);
      expect(result.cancelled).toBe(count >= cancelAfter);
      expect(completed).toBe(started.size);
      expect(completed).toBeGreaterThanOrEqual(Math.min(count, cancelAfter));
      expect(completed).toBeLessThanOrEqual(Math.min(count, cancelAfter + 3));
      expect(result.counts.sizeBytes).toBe(completed);
    }
  ));
});
