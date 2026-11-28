// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { claimWorktreeOwnership, ok, type Repo, type Result } from "@pwrgit/shared";
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

// Targeted lists arbitrate within the answer in main. The renderer then needs
// the same arbitration over the answer spliced into its current display order.
function referenceMerge(current: Repo[], asked: string[], fresh: Repo[]): Repo[] {
  return claimWorktreeOwnership(current.flatMap((repo) => {
    if (!asked.includes(repo.id)) return [repo];
    const replacement = fresh.find((next) => next.id === repo.id);
    return replacement === undefined ? [] : [replacement];
  }));
}

type Change = { profileId: string; repoIds?: string[] };

function mockList(list: (request: Change) => Repo[] | Promise<Repo[]>) {
  const listeners = new Map<string, (payload: unknown) => void>();
  mocks.subscribe.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
    listeners.set(channel, listener);
    return () => listeners.delete(channel);
  });
  mocks.dispatch.mockImplementation(async (name: string, request: Change) =>
    name === "repo:list" ? ok(await list(request)) : ok(null)
  );
  return {
    changed: (change: Change) => listeners.get("repo:changed")!(change),
    removed: (worktreeId: string) => listeners.get("worktree:removed")!({ worktreeId })
  };
}

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
  it("checks no paths or ids on a stable sibling when one repo is refreshed", async () => {
    const sibling = makeRepo(1);
    const { id, path } = sibling.worktrees[0]!;
    const idRead = vi.fn(() => id);
    const pathRead = vi.fn(() => path);
    Object.defineProperties(sibling.worktrees[0]!, {
      id: { get: idRead },
      path: { get: pathRead }
    });
    const fresh = makeRepo(0);
    const { changed } = mockList(({ repoIds }) =>
      repoIds === undefined ? [makeRepo(0), sibling] : [fresh]
    );
    let tree!: UseRepoTree;
    function Probe() {
      tree = useRepoTree("personal");
      return null;
    }

    await act(async () => root.render(<Probe />));
    idRead.mockClear();
    pathRead.mockClear();
    // A hidden repo has no row in either list even if its id is in the event.
    await act(async () => changed({ profileId: "personal", repoIds: ["repo-0", "hidden"] }));

    expect(pathRead).not.toHaveBeenCalled();
    expect(idRead).not.toHaveBeenCalled();
    expect(tree.repos).toHaveLength(2);
    expect(tree.repos[0]).toBe(fresh);
    expect(tree.repos[1]).toBe(sibling);
  });

  it("matches full ownership arbitration across mixed full and targeted snapshots", () => {
    const repoId = fc.nat(5);
    // The stored worktree id comes from the checkout path. Different repos
    // can claim that checkout in a legacy database or across two responses.
    const worktreePath = fc.nat(8);
    const snapshot = fc.uniqueArray(
      fc.record({ index: repoId, paths: fc.array(worktreePath, { maxLength: 6 }) }),
      { selector: ({ index }) => index, minLength: 1, maxLength: 6 }
    );
    const refresh = fc.record({
      snapshot,
      asked: fc.option(fc.uniqueArray(repoId), { nil: undefined })
    });
    fc.assert(fc.property(fc.array(refresh, { minLength: 1, maxLength: 12 }), (steps) => {
      let current: Repo[] = [];
      let expected: Repo[] = [];
      for (const { snapshot, asked } of steps) {
        const visible = snapshot.map(({ index, paths }) => {
          const repo = makeRepo(index);
          return {
            ...repo,
            worktrees: paths.map((path) => ({
              ...repo.worktrees[0]!,
              id: `worktree-${path}`,
              path: `/sandbox/repo-${path}`,
              isPrimary: path === index
            }))
          };
        });
        if (asked === undefined) {
          current = expected = claimWorktreeOwnership(visible);
        } else {
          const ids = asked.map((index) => `repo-${index}`);
          const fresh = claimWorktreeOwnership(visible.filter((repo) => ids.includes(repo.id)));
          expected = referenceMerge(expected, ids, fresh);
          current = mergeChangedRepos(current, ids, fresh);
        }
        expect(current).toEqual(expected);
      }
    }));
  });

  it("arbitrates against incremental removals and drops superseded responses", async () => {
    vi.useFakeTimers();
    const pending: { request: Change; resolve: (repos: Repo[]) => void }[] = [];
    const { changed, removed } = mockList((request) => new Promise<Repo[]>((resolve) => {
      pending.push({ request, resolve });
    }));
    function replyTo(request: Change, repos: Repo[]) {
      const reply = pending.shift();
      expect(reply?.request).toEqual(request);
      return act(async () => reply!.resolve(repos));
    }
    let tree!: UseRepoTree;
    function Probe({ profileId }: { profileId: string }) {
      tree = useRepoTree(profileId);
      return null;
    }
    const profileId = "personal";
    const full = { profileId };
    const first = { profileId, repoIds: ["repo-0"] };
    const second = { profileId, repoIds: ["repo-1"] };
    const aliasRepo = makeRepo(0);
    const primaryRepo = makeRepo(1);
    const primary = primaryRepo.worktrees[0]!;
    const withAlias = {
      ...aliasRepo,
      worktrees: [...aliasRepo.worktrees, { ...primary, repoId: aliasRepo.id }]
    };
    await act(async () => root.render(<Probe profileId={profileId} />));
    await replyTo(full, [aliasRepo, primaryRepo]);

    // A removal publishes while the first answer is in flight. The second
    // targeted read waits and can give the worktree back to its true primary.
    act(() => {
      changed(first);
      removed(primary.id);
      changed(second);
    });
    expect(pending).toHaveLength(1);
    let expected = referenceMerge([aliasRepo, { ...primaryRepo, worktrees: [] }], first.repoIds, [withAlias]);
    await replyTo(first, [withAlias]);
    expect(tree.repos).toEqual(expected);
    expected = referenceMerge(expected, second.repoIds, [primaryRepo]);
    await replyTo(second, [primaryRepo]);
    expect(tree.repos).toEqual(expected);
    expect(tree.repos[1]).toBe(primaryRepo);

    act(() => {
      vi.advanceTimersByTime(TARGETED_BURST_COALESCE_MS);
      changed(first);
      changed(second);
      changed(full);
    });
    expect(pending).toHaveLength(2);
    await replyTo(first, []);
    expect(tree.repos).toEqual(expected);
    const newFull = [primaryRepo, makeRepo(2), aliasRepo];
    await replyTo(full, newFull);
    expect(tree.repos).toEqual(newFull);
    expect(pending).toHaveLength(0);

    // A targeted read started after a full read can apply to the full list
    // if its answer arrives second. Ownership uses that latest list order.
    act(() => {
      changed(full);
      changed(first);
    });
    await replyTo(full, [aliasRepo, primaryRepo]);
    await replyTo(first, [withAlias]);
    expect(tree.repos).toEqual(referenceMerge([aliasRepo, primaryRepo], first.repoIds, [withAlias]));

    act(() => vi.advanceTimersByTime(TARGETED_BURST_COALESCE_MS));
    act(() => changed(first));
    expect(pending).toHaveLength(1);
    await act(async () => root.render(<Probe profileId="other" />));
    const stale = pending.shift()!;
    expect(stale.request).toEqual(first);
    const other = [{ ...makeRepo(3), profileId: "other" }];
    await replyTo({ profileId: "other" }, other);
    await act(async () => stale.resolve([withAlias]));
    expect(tree.repos).toEqual(other);
    expect(pending).toHaveLength(0);
  });

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
