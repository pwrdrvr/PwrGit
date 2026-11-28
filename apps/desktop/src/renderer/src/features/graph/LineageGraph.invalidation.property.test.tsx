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
import { showErrorToast } from "../../lib/toast";

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
  vi.useFakeTimers();
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
  vi.useRealTimers();
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

const makeGraph = (pr: PrSummary | null): LaneGraph => ({
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
    ...(pr === null ? {} : { "feat-1": { pr } })
  }
});

describe("LineageGraph pr:changed invalidation invariants", () => {
  it("skips graph:lanes reload and extra commits on equivalent pr:changed deltas, but reloads on real PR changes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.boolean(),
        async (equivalentCount, changeKnownBranch) => {
          const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
          scrollIntoView.mockClear();
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
                  onEditHistory={() => undefined}
                  onCommitsChange={() => undefined}
                  onOpenCommit={() => undefined}
                  onRevealWorktree={() => undefined}
                  onRevealCreatedWorktree={() => undefined}
                />
              </Profiler>
            );
          });

          // Loading lanes schedules a frame that centers and flashes HEAD.
          // Count that mount update before measuring PR deltas. Keep the
          // flash expiry and relative clock on fake time during the deltas.
          await act(async () => {
            vi.advanceTimersToNextFrame();
          });
          expect(scrollIntoView).toHaveBeenCalledTimes(1);
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
      // Replay the CI case and always exercise both kinds of real PR change.
      { numRuns: 12, examples: [[5, false], [1, true]] }
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

type LaneRequest = { worktreeId: string; scope: "active" | "all"; force: boolean; revealHash?: string };
type LaneReply = ReturnType<typeof ok<LaneGraph>> | { ok: false; error: { message: string } };

function controlledGraph() {
  const requests: {
    input: LaneRequest;
    finish: (reply: LaneReply) => void;
    reject: (error: Error) => void;
  }[] = [];
  const search = vi.fn();
  const noop = () => undefined;
  const selectedCommits = new Set<string>();
  mocks.dispatch.mockImplementation((name: string, input: LaneRequest) => {
    if (name === "graph:lanes") {
      return new Promise<LaneReply>((finish, reject) => requests.push({ input, finish, reject }));
    }
    if (name === "settings:read") return Promise.resolve(ok({ experimental: {} }));
    return Promise.resolve(ok({}));
  });
  return {
    requests,
    search,
    render: (worktreeId = "wt-1", repoId = "repo-1", revealHash?: string) =>
      act(async () => root.render(
        <LineageGraph repoId={repoId} repoName={repoId} worktreeId={worktreeId}
          worktreePath={`/synthetic/${worktreeId}`} viewingBranch="feat-1" activeEmail=""
          selectedCommits={selectedCommits} focusedCommit={null}
          revealCommit={revealHash === undefined ? null : { hash: revealHash, requestId: 1 }}
          onEditHistory={noop} onCommitsChange={search} onOpenCommit={noop}
          onRevealWorktree={noop} onRevealCreatedWorktree={noop} />
      )),
    invalidate: (repoId = "repo-1") =>
      act(async () => emit("graph:changed", { repoId })),
    changePr: (pr: PrSummary | null) =>
      act(async () => emit("pr:changed", { repoId: "repo-1", prs: { "feat-1": pr } })),
    finish: (index: number, label: string, fail = false, pr: PrSummary | null = makePr(42, "open")) => act(async () => {
      const graph = makeGraph(pr);
      graph.commits[0]!.subject = label;
      requests[index]!.finish(fail ? { ok: false, error: { message: label } } : ok(graph));
    }),
    reject: (index: number) =>
      act(async () => requests[index]!.reject(new Error("Synthetic IPC failure"))),
    switchScope: () =>
      act(async () => container.querySelector<HTMLButtonElement>(".only-me")!.click())
  };
}

const traceBurstMs = [0, 111, 259, 450, 592, 792, 951, 951];

describe("Lineage repo invalidation reads", () => {
  it.each([false, true])("replays capture #3, with a sibling switch at 1115 ms: %s", async (switchWorktree) => {
    const view = controlledGraph();
    await view.render();
    await view.finish(0, "Initial");
    expect(view.requests[0]!.input.force).toBe(false);
    let elapsed = 0;
    for (const at of traceBurstMs) {
      await act(async () => { vi.advanceTimersByTime(at - elapsed); });
      elapsed = at;
      await view.invalidate();
      // The first invalidation reads immediately. Subsequent events do not
      // start another read of this view until that answer comes back.
      expect(view.requests).toHaveLength(2);
    }
    expect(view.requests[1]!.input.force).toBe(true);
    if (switchWorktree) {
      await act(async () => { vi.advanceTimersByTime(1115 - elapsed); });
      await view.render("wt-2");
      expect(view.requests[2]!.input).toMatchObject({ worktreeId: "wt-2", force: true });
      await act(async () => { vi.advanceTimersByTime(77); });
      await view.finish(2, "Sibling with final tags");
      await view.finish(1, "Superseded worktree", true);
      expect(container.textContent).toContain("Sibling with final tags");
      expect(container.textContent).not.toContain("Superseded worktree");
    } else {
      await view.finish(1, "Stale read");
      expect(view.requests[2]!.input).toMatchObject({ worktreeId: "wt-1", force: true });
      expect(container.textContent).toContain("Initial");
      await view.finish(2, "Latest tags");
      expect(container.textContent).toContain("Latest tags");
    }
    expect(view.requests).toHaveLength(3);
    expect(view.search.mock.calls.map(([commits]) => commits[0].subject)).toEqual(
      switchWorktree ? ["Initial", "Sibling with final tags"] : ["Initial", "Latest tags"]
    );
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it.each(["scope", "reveal", "repo"] as const)("keeps an obsolete %s generation out of rows and search", async (boundary) => {
    const view = controlledGraph();
    await view.render();
    await view.finish(0, "Initial");
    await view.invalidate();
    await view.invalidate();

    const revealHash = "a".repeat(40);
    if (boundary === "scope") await view.switchScope();
    if (boundary === "reveal") await view.render("wt-1", "repo-1", revealHash);
    if (boundary === "repo") await view.render("wt-2", "repo-2");
    expect(view.requests[2]!.input).toEqual({
      worktreeId: boundary === "repo" ? "wt-2" : "wt-1",
      scope: boundary === "scope" ? "all" : "active",
      force: boundary !== "repo",
      ...(boundary === "reveal" ? { revealHash } : {})
    });
    await view.finish(2, "New selection");
    await view.finish(1, "Obsolete selection");
    expect(container.textContent).toContain("New selection");
    expect(view.search.mock.calls.map(([commits]) => commits[0].subject)).toEqual(["Initial", "New selection"]);

    if (boundary === "reveal") {
      await view.render();
      expect(view.requests[3]!.input).toEqual({ worktreeId: "wt-1", scope: "active", force: false });
    }
    if (boundary === "repo") {
      await view.render();
      expect(view.requests[3]!.input).toEqual({ worktreeId: "wt-1", scope: "active", force: true });
    }
  });

  it("shows the first PR and later deltas for a visible branch missing from All adornments", async () => {
    const prNumber = fc.integer({ min: 1, max: 999 });
    await fc.assert(fc.asyncProperty(
      prNumber,
      fc.array(fc.option(prNumber, { nil: null }), { maxLength: 6 }),
      async (firstPr, changes) => {
        const view = controlledGraph();
        try {
          await view.render();
          await view.finish(0, "Active history", false, null);
          await view.switchScope();
          await view.finish(1, "All history", false, null);
          const branchTip = container.querySelector('.graph-row[data-hash="c2"]')!;
          expect(branchTip.textContent).toContain("feat-1");
          expect(branchTip.querySelector(".pr-chip")).toBeNull();
          for (const number of [firstPr, ...changes]) {
            await view.changePr(number === null ? null : makePr(number, "open"));
            // All already draws the branch. The chip follows the latest delta
            // immediately, including the first PR on a branch with no worktree.
            const chip = branchTip.querySelector(".pr-chip");
            if (number === null) expect(chip).toBeNull();
            else expect(chip?.textContent).toBe(`#${number}`);
            expect(view.requests).toHaveLength(2);
          }
        } finally {
          act(() => root.unmount());
          root = createRoot(container);
        }
      }
    ), { numRuns: 20, examples: [[42, [null, 43]]] });
  });

  it("forces Active membership after a deferred PR delta and preserves it across a superseding repo invalidation", async () => {
    const view = controlledGraph();
    await view.render();
    await view.finish(0, "Active history");
    await view.switchScope();
    expect(view.requests[1]!.input).toMatchObject({ scope: "all", force: false });
    await view.finish(1, "All history");
    await view.changePr(makePr(42, "merged"));
    expect(view.requests).toHaveLength(2);

    await view.switchScope();
    expect(view.requests[2]!.input).toMatchObject({ scope: "active", force: true });
    await view.invalidate();
    await view.finish(2, "Obsolete membership");
    expect(view.requests[3]!.input).toMatchObject({ scope: "active", force: true });
    expect(container.textContent).toContain("All history");
    await view.finish(3, "Reconciled membership");
    expect(container.textContent).toContain("Reconciled membership");
    await view.render("wt-2");
    expect(view.requests[4]!.input).toMatchObject({ worktreeId: "wt-2", scope: "active", force: false });
  });

  it("shows a current transport error once and resumes reading on the next invalidation", async () => {
    const view = controlledGraph();
    await view.render();
    await view.reject(0);
    expect(container.textContent).toContain("Synthetic IPC failure");
    expect(showErrorToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      key: "history:wt-1", title: "History unavailable", detail: "Synthetic IPC failure"
    }));
    await view.invalidate();
    expect(container.textContent).toContain("Loading history");
    await view.finish(1, "Recovered history");
    expect(container.textContent).toContain("Recovered history");
  });

  it("reads promptly and eventually publishes the last repository version through arbitrary event and completion sequences", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("invalidate", "unrelated", "complete", "fail"), { minLength: 1, maxLength: 22 }),
      async (steps) => {
        const view = controlledGraph();
        vi.mocked(showErrorToast).mockClear();
        await view.render();
        expect(view.requests).toHaveLength(1);
        let repoVersion = 0;
        let lastAttemptedVersion = 0;
        let nextReply = 0;
        let currentError = false;
        let errors = 0;
        const successes: string[] = [];
        try {
          for (const step of [...steps, "complete", "complete"]) {
            const before = view.requests.length;
            if (step === "invalidate") {
              repoVersion += 1;
              await view.invalidate();
            } else if (step === "unrelated") {
              await view.invalidate("other-repo");
              expect(view.requests).toHaveLength(before);
            } else if (nextReply < before) {
              const label = `Version ${lastAttemptedVersion}`;
              const failed = step === "fail";
              await view.finish(nextReply, failed ? "Synthetic failure" : label, failed);
              nextReply += 1;
              if (lastAttemptedVersion === repoVersion) {
                currentError = failed;
                if (failed) errors += 1;
                else if (label !== successes.at(-1)) successes.push(label);
              }
            }
            // A busy reader need not start another read. An idle reader must
            // have attempted the newest observable version.
            expect(view.requests.length - nextReply).toBeLessThanOrEqual(1);
            if (view.requests.length > before) {
              lastAttemptedVersion = repoVersion;
              currentError = false;
            }
            if (view.requests.length === nextReply) expect(lastAttemptedVersion).toBe(repoVersion);
            expect(view.search.mock.calls.map(([commits]) => commits[0].subject)).toEqual(successes);
            expect(showErrorToast).toHaveBeenCalledTimes(errors);
            expect(container.textContent).toContain(
              successes.at(-1) ?? (currentError ? "Synthetic failure" : "Loading history")
            );
          }
        } finally {
          act(() => root.unmount());
          root = createRoot(container);
        }
      }
    ), { numRuns: 24 });
  });
});
