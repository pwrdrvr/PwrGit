// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { ok, type Repo, type Result } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../lib/pwrgit", () => mocks);
vi.mock("../features/shell/dialogs", () => ({
  confirmDialog: vi.fn(),
  notifyDialog: vi.fn()
}));
vi.mock("../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import {
  mergeChangedRepos,
  TARGETED_BURST_COALESCE_MS,
  useRepoTree,
  type UseRepoTree
} from "./useRepoTree";

const makeRepo = (index: number, behind = 0): Repo => ({
  id: `repo-${index}`,
  name: `repo-${index}`,
  path: `/sandbox/repo-${index}`,
  profileId: "personal",
  pinned: false,
  worktrees: [
    {
      id: `repo-${index}-wt-0`,
      repoId: `repo-${index}`,
      path: `/sandbox/repo-${index}`,
      branch: "main",
      dirty: 0,
      ahead: 0,
      behind,
      behindDefault: 0,
      defaultBranch: "main",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      isDefaultBranch: true,
      isPrimary: true,
      pinned: false
    }
  ]
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useRepoTree targeted coalescing and reference stability properties", () => {
  it("mergeChangedRepos preserves every unasked sibling reference while replacing asked repos", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),
        fc.array(fc.nat(15), { minLength: 1, maxLength: 8 }),
        (count, rawIndices) => {
          const current = Array.from({ length: count }, (_, i) => makeRepo(i, i % 3));
          const asked = [...new Set(rawIndices.map((n) => `repo-${n % count}`))];
          const askedSet = new Set(asked);
          const fresh = asked.map((id) =>
            structuredClone(current.find((r) => r.id === id)!)
          );
          const freshById = new Map(fresh.map((r) => [r.id, r]));
          const merged = mergeChangedRepos(current, asked, fresh);
          expect(merged).toHaveLength(count);
          for (let i = 0; i < count; i++) {
            const orig = current[i]!;
            if (askedSet.has(orig.id)) {
              expect(merged[i]).toBe(freshById.get(orig.id));
            } else {
              expect(merged[i]).toBe(orig);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("coalesces rapid targeted repo:changed bursts while keeping single updates immediate and eventually consistent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 4, max: 14 }),
        fc.integer({ min: 15, max: 60 }),
        async (repoCount, stepMs) => {
          vi.useFakeTimers();
          try {
            const backend = new Map<string, Repo>(
              Array.from({ length: repoCount }, (_, i) => [
                `repo-${i}`,
                makeRepo(i, 2)
              ])
            );
            let repoChanged:
              | ((payload: { profileId: string; repoIds?: string[] }) => void)
              | undefined;
            let targetedCalls = 0;

            mocks.subscribe.mockImplementation(
              (channel: string, listener: typeof repoChanged) => {
                if (channel === "repo:changed") repoChanged = listener;
                return vi.fn();
              }
            );
            mocks.dispatch.mockImplementation(
              (
                name: string,
                req?: { profileId?: string; repoIds?: string[] }
              ): Promise<Result<unknown>> => {
                if (name === "repo:list") {
                  if (req?.repoIds !== undefined) {
                    targetedCalls += 1;
                    return Promise.resolve(
                      ok(
                        req.repoIds
                          .map((id) => backend.get(id))
                          .filter((r): r is Repo => r !== undefined)
                          .map((r) => structuredClone(r))
                      )
                    );
                  }
                  return Promise.resolve(
                    ok([...backend.values()].map((r) => structuredClone(r)))
                  );
                }
                return Promise.resolve(ok(null));
              }
            );

            let tree!: UseRepoTree;
            let reposCommits = 0;
            let prevRepos: Repo[] | null = null;
            function Probe() {
              tree = useRepoTree("personal");
              if (tree.repos !== prevRepos) {
                prevRepos = tree.repos;
                reposCommits += 1;
              }
              return null;
            }

            await act(async () => root.render(<Probe />));
            expect(tree.repos).toHaveLength(repoCount);
            const commitsAfterBoot = reposCommits;

            // Rule 1: First targeted repo:changed after idle runs immediately (0ms delay).
            backend.set("repo-0", makeRepo(0, 0));
            await act(async () => {
              repoChanged?.({ profileId: "personal", repoIds: ["repo-0"] });
            });
            expect(targetedCalls).toBe(1);
            expect(tree.repos[0]!.worktrees[0]!.behind).toBe(0);

            // Rule 2: Remaining repos arrive sequentially inside the burst window.
            for (let i = 1; i < repoCount; i++) {
              await act(async () => {
                vi.advanceTimersByTime(stepMs);
              });
              backend.set(`repo-${i}`, makeRepo(i, 0));
              await act(async () => {
                repoChanged?.({ profileId: "personal", repoIds: [`repo-${i}`] });
              });
            }

            // Flush any trailing coalesced batch.
            await act(async () => {
              vi.advanceTimersByTime(TARGETED_BURST_COALESCE_MS + 10);
            });

            // Rule 3: Eventual consistency — every repo reflects its final state.
            for (let i = 0; i < repoCount; i++) {
              expect(tree.repos[i]!.worktrees[0]!.behind).toBe(0);
            }

            // Rule 4: Work-count bound — burst must coalesce strictly below 1-per-repo.
            const burstDurationMs = (repoCount - 1) * stepMs;
            const maxExpectedReads =
              1 + Math.ceil(burstDurationMs / TARGETED_BURST_COALESCE_MS) + 1;
            expect(targetedCalls).toBeLessThanOrEqual(maxExpectedReads);
            expect(targetedCalls).toBeLessThan(repoCount);
            expect(reposCommits - commitsAfterBoot).toBeLessThanOrEqual(
              targetedCalls
            );
          } finally {
            act(() => root.unmount());
            root = createRoot(container);
            vi.useRealTimers();
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
