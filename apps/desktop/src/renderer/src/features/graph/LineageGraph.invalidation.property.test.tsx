// @vitest-environment jsdom
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { ok, type LaneGraph, type PrSummary } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (payload: unknown) => void;
const channels = new Map<string, Set<Listener>>();

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  windowProfileId: vi.fn(() => "personal")
}));

vi.mock("../../lib/pwrgit", () => mocks);
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));
vi.mock("../shell/dialogs", () => ({
  confirmDialog: vi.fn(),
  notifyDialog: vi.fn()
}));

import { LineageGraph } from "./LineageGraph";

function emit(channel: string, payload: unknown): void {
  for (const listener of [...(channels.get(channel) ?? [])]) {
    listener(payload);
  }
}

let container: HTMLDivElement;
let root: Root;
let originalScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  channels.clear();
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
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
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  }
  vi.unstubAllGlobals();
});

const makePr = (number: number, state: "open" | "merged"): PrSummary => ({
  number,
  url: `https://example.test/pr/${number}`,
  title: `PR #${number}`,
  state,
  isDraft: false,
  headRefName: "feat-1",
  baseRefName: "main",
  checkState: "passing"
});

const makeGraph = (pr: PrSummary): LaneGraph => ({
  head: "c2",
  defaultBranch: "main",
  defaultRef: "origin/main",
  defaultRefTips: ["c1"],
  headUpstream: "origin/feat-1",
  shownBranches: ["main", "feat-1"],
  upstreamRefs: ["origin/feat-1"],
  matchedBranches: 2,
  hiddenBranches: 0,
  headOnlyCommits: [],
  commits: [
    {
      hash: "c2",
      shortHash: "c2",
      parents: ["c1"],
      subject: "Feature work",
      authorName: "Test Author",
      authorEmail: "test@example.test",
      committedAt: "2026-11-26T10:00:00Z",
      isMerge: false
    },
    {
      hash: "c1",
      shortHash: "c1",
      parents: [],
      subject: "Initial commit",
      authorName: "Test Author",
      authorEmail: "test@example.test",
      committedAt: "2026-11-26T09:00:00Z",
      isMerge: false
    }
  ],
  tips: { c2: ["feat-1"], c1: ["main"] },
  remoteTips: { c2: ["origin/feat-1"], c1: ["origin/main"] },
  branches: {
    main: {},
    "feat-1": { pr }
  }
});

describe("LineageGraph pr:changed invalidation invariants", () => {
  it("skips graph:lanes reload and extra commits on equivalent pr:changed deltas, but reloads on real PR changes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.boolean(),
        async (equivalentCount, changeKnownBranch) => {
          const initialPr = makePr(42, "open");
          let currentGraph = makeGraph(initialPr);
          let laneDispatches = 0;

          mocks.dispatch.mockImplementation((name: string) => {
            if (name === "graph:lanes") {
              laneDispatches += 1;
              return Promise.resolve(ok(structuredClone(currentGraph)));
            }
            if (name === "people:replaceInterest") return Promise.resolve(ok({}));
            if (name === "pr:refresh") return Promise.resolve(ok(null));
            if (name === "pr:replaceVisibleCommits") return Promise.resolve(ok({}));
            if (name === "settings:read") {
              return Promise.resolve(ok({ experimental: { lineageAllBranches: false } }));
            }
            return Promise.resolve(ok(null));
          });

          let commits = 0;
          await act(async () => {
            root.render(
              <Profiler id="lineage" onRender={() => { commits += 1; }}>
                <LineageGraph
                  repoId="repo-1"
                  repoName="repo-1"
                  worktreeId="wt-1"
                  worktreePath="/sandbox/repo-1"
                  viewingBranch="feat-1"
                  activeEmail="test@example.test"
                  selectedCommits={new Set()}
                  focusedCommit={null}
                  revealCommit={null}
                  tidyOffered={false}
                  onEditHistory={() => undefined}
                  onCommitsChange={() => undefined}
                  onOpenCommit={() => undefined}
                  onRevealWorktree={() => undefined}
                  onRevealCreatedWorktree={() => undefined}
                />
              </Profiler>
            );
          });

          const settledLanes = laneDispatches;
          const settledCommits = commits;

          // Equivalent pr:changed events for known branches must trigger ZERO reloads and ZERO commits.
          for (let i = 0; i < equivalentCount; i++) {
            await act(async () => {
              emit("pr:changed", {
                repoId: "repo-1",
                prs: {
                  "feat-1": structuredClone(initialPr),
                  main: null
                }
              });
            });
          }
          expect(laneDispatches).toBe(settledLanes);
          expect(commits).toBe(settledCommits);

          // A real PR change (or an unknown branch that could enter/leave Active scope) MUST reload Active lanes.
          const changedPr = makePr(42, "merged");
          currentGraph = makeGraph(changedPr);
          await act(async () => {
            emit("pr:changed", {
              repoId: "repo-1",
              prs: changeKnownBranch
                ? { "feat-1": changedPr }
                : { "other-branch": makePr(99, "open") }
            });
          });
          expect(laneDispatches).toBe(settledLanes + 1);

          act(() => root.unmount());
          root = createRoot(container);
        }
      ),
      { numRuns: 10, seed: 2026112607 }
    );
  });

  it("clears Loading history… when reloading after an initial graph:lanes failure", async () => {
    let attempt = 0;
    const recoveredGraph = makeGraph(makePr(7, "open"));
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "graph:lanes") {
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve({
            ok: false as const,
            error: { code: "git_failed", message: "transient error" }
          });
        }
        return Promise.resolve(ok(structuredClone(recoveredGraph)));
      }
      if (name === "people:replaceInterest") return Promise.resolve(ok({}));
      if (name === "pr:replaceVisibleCommits") return Promise.resolve(ok({}));
      return Promise.resolve(ok(null));
    });

    const renderGraph = (worktreeId: string) =>
      act(async () => {
        root.render(
          <LineageGraph
            repoId="repo-1"
            repoName="repo-1"
            worktreeId={worktreeId}
            worktreePath={`/sandbox/repo-1/${worktreeId}`}
            viewingBranch="feat-1"
            activeEmail="test@example.test"
            selectedCommits={new Set()}
            focusedCommit={null}
            revealCommit={null}
            tidyOffered={false}
            onEditHistory={() => undefined}
            onCommitsChange={() => undefined}
            onOpenCommit={() => undefined}
            onRevealWorktree={() => undefined}
            onRevealCreatedWorktree={() => undefined}
          />
        );
      });

    await renderGraph("wt-1");
    expect(container.textContent).not.toContain("Loading history");

    // Switching worktree while data is still null re-enters loading and must
    // sync loadingRef so a fast resolved graph:lanes clears Loading history….
    await renderGraph("wt-2");
    expect(container.textContent).not.toContain("Loading history");
    expect(container.textContent).toContain("Feature work");
  });
});
