// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import {
  ok,
  type CommitIdentityInspection,
  type ForkStatus,
  type HiddenRepo,
  type PrSummary,
  type RemoteActivity,
  type Repo,
  type Result,
  type WorktreeState
} from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const channels = new Map<string, Set<Listener>>();

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  windowProfileId: vi.fn(() => "personal")
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

import { useWorktreeState } from "./useWorktreeState";
import { useForkStatus } from "./useForkStatus";
import { useRemoteActivityFor, useRepoRemoteActivity } from "./useRemoteActivity";
import { useRepoTree, type UseRepoTree } from "./useRepoTree";
import { useHiddenRepos } from "./useHiddenRepos";
import { useCommitIdentity } from "../features/identity/useCommitIdentity";
import { inspection as makeIdentityInspection } from "../features/identity/identity-test-fixtures";

function emit(channel: string, payload: unknown): void {
  for (const listener of [...(channels.get(channel) ?? [])]) {
    listener(payload);
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  channels.clear();
  mocks.subscribe.mockImplementation((channel: string, listener: Listener) => {
    let set = channels.get(channel);
    if (set === undefined) {
      set = new Set();
      channels.set(channel, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const makeState = (rev: number, dirty: number): WorktreeState => ({
  worktreeId: "wt-1",
  head: `head-${rev}`,
  branch: "main",
  hasUpstream: true,
  ahead: rev % 3,
  behind: 0,
  dirty,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  updatedAt: "2026-11-26T00:00:00Z"
});

const makePr = (number: number, state: "open" | "merged" = "open"): PrSummary => ({
  number,
  url: `https://example.test/pr/${number}`,
  title: `PR #${number}`,
  state,
  isDraft: false,
  headRefName: "feat",
  baseRefName: "main",
  checkState: "passing"
});

const makeRepo = (id: string, branches: string[]): Repo => ({
  id,
  name: id,
  path: `/sandbox/${id}`,
  profileId: "personal",
  pinned: false,
  worktrees: branches.map((branch, idx) => ({
    id: `${id}-wt-${idx}`,
    repoId: id,
    path: `/sandbox/${id}/${branch}`,
    branch,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: idx === 0,
    isPrimary: idx === 0,
    pinned: false,
    ...(idx === 0 ? { pr: makePr(100 + idx) } : {})
  }))
});

describe("state-hook ordering and structural stability properties", () => {
  it("useWorktreeState rejects out-of-order stale replies and skips commits on equivalent replies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            rev: fc.integer({ min: 1, max: 6 }),
            dirty: fc.integer({ min: 0, max: 3 }),
            deliverOutOfOrder: fc.boolean()
          }),
          { minLength: 2, maxLength: 6 }
        ),
        async (steps) => {
          const pending: Array<{
            seq: number;
            resolve: (res: Result<WorktreeState>) => void;
          }> = [];
          let seq = 0;
          mocks.dispatch.mockImplementation((name: string) => {
            if (name === "worktree:getState") {
              const mine = ++seq;
              return new Promise<Result<WorktreeState>>((resolve) => {
                pending.push({ seq: mine, resolve });
              });
            }
            return Promise.resolve(ok(null));
          });

          let renders = 0;
          let latest: WorktreeState | null = null;
          function Probe() {
            renders += 1;
            latest = useWorktreeState("wt-1");
            return null;
          }

          await act(async () => root.render(<Probe />));
          expect(pending).toHaveLength(1);
          const initial = makeState(0, 0);
          await act(async () => {
            pending.shift()!.resolve(ok(structuredClone(initial)));
          });
          expect(latest).toEqual(initial);

          // Equivalent reply must cause zero commits.
          const rendersBeforeEq = renders;
          const refBeforeEq = latest;
          await act(async () => {
            emit("worktree:changed", { worktreeId: "wt-1" });
          });
          await act(async () => {
            pending.shift()!.resolve(ok(structuredClone(initial)));
          });
          expect(renders).toBe(rendersBeforeEq);
          expect(latest).toBe(refBeforeEq);

          // Interleaved overlapping replies: newest request must win even if
          // older request resolves afterwards.
          const expectedStates = steps.map((s) => makeState(s.rev, s.dirty));
          await act(async () => {
            for (let i = 0; i < steps.length; i++) {
              emit("worktree:changed", { worktreeId: "wt-1" });
            }
          });
          expect(pending).toHaveLength(steps.length);

          // Resolve the newest request first, then resolve older ones in reverse.
          const newest = pending.pop()!;
          const newestState = expectedStates.at(-1)!;
          await act(async () => {
            newest.resolve(ok(structuredClone(newestState)));
          });
          expect(latest).toEqual(newestState);
          const rendersAtNewest = renders;

          while (pending.length > 0) {
            const stale = pending.pop()!;
            const staleState = expectedStates[stale.seq - 2] ?? makeState(99, 9);
            await act(async () => {
              stale.resolve(ok(structuredClone(staleState)));
            });
            expect(latest).toEqual(newestState);
            expect(renders).toBe(rendersAtNewest);
          }

          act(() => root.unmount());
          root = createRoot(container);
        }
      ),
      { numRuns: 20, seed: 2026112602 }
    );
  });

  it("useForkStatus performs zero extra commits on equivalent null or status replies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc.record({
            behind: fc.integer({ min: 0, max: 10 }),
            ahead: fc.integer({ min: 0, max: 10 })
          }),
          { nil: null }
        ),
        fc.integer({ min: 1, max: 6 }),
        async (counts, repeats) => {
          const payload: ForkStatus | null =
            counts === null
              ? null
              : {
                  branch: "main",
                  head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  source: {
                    ref: "refs/remotes/upstream/main",
                    label: "upstream/main",
                    remote: "upstream",
                    head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    ahead: counts.ahead,
                    behind: counts.behind,
                    pushBack: null
                  },
                  tracked: null,
                  drift: null
                };

          mocks.dispatch.mockImplementation((name: string) => {
            if (name === "remote:forkStatus") {
              return Promise.resolve(ok(structuredClone(payload)));
            }
            return Promise.resolve(ok(null));
          });

          let renders = 0;
          let latest: ForkStatus | null | undefined;
          function Probe() {
            renders += 1;
            latest = useForkStatus("wt-1", "repo-1", "main");
            return null;
          }

          await act(async () => root.render(<Probe />));
          expect(latest).toEqual(payload);
          const settledRenders = renders;

          for (let i = 0; i < repeats; i++) {
            await act(async () => {
              emit(i % 2 === 0 ? "worktree:changed" : "graph:changed", {
                worktreeId: "wt-1",
                repoId: "repo-1"
              });
            });
          }

          expect(renders).toBe(settledRenders);
          act(() => root.unmount());
          root = createRoot(container);
        }
      ),
      { numRuns: 20, seed: 2026112603 }
    );
  });

  it("useRemoteActivityFor and useRepoRemoteActivity ignore unrelated worktree/repo activity updates", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            targetWt: fc.constantFrom("wt-other-1", "wt-other-2", "wt-1"),
            repoId: fc.constantFrom("repo-other", "repo-1"),
            phase: fc.constantFrom("fetch" as const, "fast_forward" as const),
            elapsed: fc.integer({ min: 1, max: 500 })
          }),
          { minLength: 1, maxLength: 10 }
        ),
        async (updates) => {
          mocks.dispatch.mockResolvedValue(ok([]));
          let wtRenders = 0;
          let repoRenders = 0;
          let latestWt: RemoteActivity | null = null;
          let latestRepo: RemoteActivity | null = null;

          function WtProbe() {
            wtRenders += 1;
            latestWt = useRemoteActivityFor("wt-1");
            return null;
          }
          function RepoProbe() {
            repoRenders += 1;
            latestRepo = useRepoRemoteActivity("repo-1", "fetch");
            return null;
          }

          await act(async () => {
            root.render(
              <>
                <WtProbe />
                <RepoProbe />
              </>
            );
          });
          // Clear any lingering global store activity from previous iterations.
          await act(async () => {
            emit("remote:activity", { activities: [] });
          });

          const baseWtRenders = wtRenders;
          const baseRepoRenders = repoRenders;
          let expectedWtTransitions = 0;
          let prevWtJson = JSON.stringify(latestWt);

          for (let i = 0; i < updates.length; i++) {
            const u = updates[i]!;
            const nextActivity: RemoteActivity = {
              id: `act-${u.targetWt}`,
              profileId: "personal",
              repoId: u.repoId,
              repoName: u.repoId,
              worktreeId: u.targetWt,
              branch: "main",
              kind: "pull",
              phase: u.phase,
              command: "git pull",
              startedAt: 1000,
              phaseSince: 1000,
              lastOutputAt: 1000 + u.elapsed,
              silent: false,
              progress: null,
              tail: [],
              canceling: false
            };
            await act(async () => {
              emit("remote:activity", { activities: [nextActivity] });
            });
            const nextWt = u.targetWt === "wt-1" ? nextActivity : null;
            const nextWtJson = JSON.stringify(nextWt);
            if (nextWtJson !== prevWtJson) {
              expectedWtTransitions += 1;
              prevWtJson = nextWtJson;
            }
            expect(latestWt).toEqual(nextWt);
            expect(wtRenders - baseWtRenders).toBe(expectedWtTransitions);
            // None of these are worktreeId === null repo-wide fetches for repo-1.
            expect(latestRepo).toBeNull();
            expect(repoRenders).toBe(baseRepoRenders);
          }

          await act(async () => {
            emit("remote:activity", { activities: [] });
          });
          act(() => root.unmount());
          root = createRoot(container);
        }
      ),
      { numRuns: 20, seed: 2026112604 }
    );
  });

  it("useRepoTree preserves references on equivalent deltas and scopes setWorktreePin to one repo", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        async (repoCount, targetRaw) => {
          const targetIdx = targetRaw % repoCount;
          const initial = Array.from({ length: repoCount }, (_, i) =>
            makeRepo(`repo-${i}`, ["main", "feat"])
          );
          mocks.dispatch.mockImplementation((name: string) => {
            if (name === "repo:list") return Promise.resolve(ok(structuredClone(initial)));
            return Promise.resolve(ok(null));
          });

          let renders = 0;
          let tree!: UseRepoTree;
          function Probe() {
            renders += 1;
            tree = useRepoTree("personal");
            return null;
          }

          await act(async () => root.render(<Probe />));
          const settledRepos = tree.repos;
          const settledRenders = renders;

          // 1. Equivalent full repo:changed must keep the exact array & repo references.
          await act(async () => {
            emit("repo:changed", { profileId: "personal" });
          });
          expect(tree.repos).toBe(settledRepos);
          expect(renders).toBe(settledRenders);

          // 2. Equivalent pr:changed must keep the exact array & repo references.
          const targetRepo = initial[targetIdx]!;
          await act(async () => {
            emit("pr:changed", {
              repoId: targetRepo.id,
              prs: {
                main: structuredClone(targetRepo.worktrees[0]!.pr),
                feat: null
              }
            });
          });
          expect(tree.repos).toBe(settledRepos);
          expect(renders).toBe(settledRenders);

          // 3. Unknown worktree:removed must keep the exact array reference.
          await act(async () => {
            emit("worktree:removed", { worktreeId: "non-existent-wt" });
          });
          expect(tree.repos).toBe(settledRepos);
          expect(renders).toBe(settledRenders);

          // 4. setWorktreePin must replace ONLY the owning repo, keeping all sibling Repo refs intact.
          const wtToPin = targetRepo.worktrees[1]!.id;
          await act(async () => {
            tree.setWorktreePin(wtToPin, true);
          });
          for (let i = 0; i < repoCount; i++) {
            if (i === targetIdx) {
              expect(tree.repos[i]).not.toBe(settledRepos[i]);
              expect(tree.repos[i]!.worktrees[1]!.pinned).toBe(true);
            } else {
              expect(tree.repos[i]).toBe(settledRepos[i]);
            }
          }

          act(() => root.unmount());
          root = createRoot(container);
        }
      ),
      { numRuns: 15, seed: 2026112605 }
    );
  });

  it("useCommitIdentity and useHiddenRepos skip commits on equivalent focus/reload replies", async () => {
    const identityPayload: CommitIdentityInspection = makeIdentityInspection();
    const hiddenPayload: HiddenRepo[] = [
      {
        profileId: "personal",
        profileName: "Personal",
        path: "/sandbox/hidden-1",
        name: "hidden-1",
        hiddenAt: "2026-11-26T00:00:00Z",
        repoId: "repo-hidden-1",
        worktreeCount: 1,
        missing: false
      }
    ];
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "identity:inspect") return Promise.resolve(ok(structuredClone(identityPayload)));
      if (name === "repo:hiddenList") return Promise.resolve(ok(structuredClone(hiddenPayload)));
      return Promise.resolve(ok(null));
    });

    let idRenders = 0;
    let hiddenRenders = 0;
    let reloadHidden!: () => void;
    function Probe() {
      idRenders += 1;
      useCommitIdentity("wt-1", "head-1");
      return null;
    }
    function HiddenProbe() {
      hiddenRenders += 1;
      reloadHidden = useHiddenRepos("personal").reload;
      return null;
    }

    await act(async () => {
      root.render(
        <>
          <Probe />
          <HiddenProbe />
        </>
      );
    });
    const baseIdRenders = idRenders;
    const baseHiddenRenders = hiddenRenders;

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
    }
    expect(idRenders).toBe(baseIdRenders);

    await act(async () => {
      reloadHidden();
    });
    // One render for the explicit tick increment, zero second render when payload matches.
    expect(hiddenRenders).toBe(baseHiddenRenders + 1);
  });
});
