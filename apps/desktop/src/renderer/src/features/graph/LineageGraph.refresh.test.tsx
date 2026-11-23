// @vitest-environment jsdom
import { ok, type Commit, type CommitAuthorPerson, type LaneGraph } from "@pwrgit/shared";
import fc from "fast-check";
import { act, useLayoutEffect, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageGraph } from "./LineageGraph";

// Minute ticks re-render age labels independently of graph refresh replies.
vi.mock("../../lib/useRelativeClock", () => ({
  useRelativeClock: () => Date.parse("2026-11-18T12:01:00Z")
}));

const rowCommits = vi.hoisted(() => vi.fn<(subject: string, avatar: string | undefined) => void>());
vi.mock("./GraphRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./GraphRow")>();
  // Observe parent-driven row commits. The row can independently commit its
  // measured ref-chip fit, which is outside the graph publication contract.
  function ObservedRow(props: ComponentProps<typeof actual.GraphRow>) {
    useLayoutEffect(() => rowCommits(props.vm.commit.subject, props.authorAvatarUrl));
    return <actual.GraphRow {...props} />;
  }
  return { ...actual, GraphRow: ObservedRow };
});

const repoId = "widgets";
const worktreeId = "main-worktree";
const email = "author@example.test";
const hash = "a".repeat(40);
const selected = new Set([hash]);
const noop = () => undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function graph(subject: string, tagName?: string): LaneGraph {
  const commit: Commit = {
    hash, shortHash: hash.slice(0, 7), parents: [], subject,
    authorName: "Widget Author", authorEmail: email,
    committedAt: "2026-11-18T12:00:00Z", isMerge: false
  };
  return {
    commits: [commit], tips: { [hash]: ["main"] }, remoteTips: {}, branches: {},
    ...(tagName === undefined ? {} : { tags: { [hash]: { name: tagName, kind: "lightweight" } } }),
    head: hash, headOnlyCommits: [], defaultBranch: "main", defaultRef: "main",
    defaultRefTips: [hash], shownBranches: [], upstreamRefs: [],
    matchedBranches: 0, hiddenBranches: 0
  };
}

describe("LineageGraph refresh publication", () => {
  beforeEach(() => {
    rowCommits.mockClear();
    // The HEAD centering frame is unrelated to refresh publication.
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(
    initial: LaneGraph,
    initialPeople: Record<string, CommitAuthorPerson> = {}
  ) {
    const container = document.createElement("div");
    const root = createRoot(container);
    const subscriptions = new Map<string, (payload: unknown) => void>();
    const requests: unknown[] = [];
    const search = vi.fn<(commits: Commit[]) => void>();
    const navigate = vi.fn();
    let nextGraph: () => Promise<LaneGraph> = async () => initial;
    let nextPeople = initialPeople;
    vi.stubGlobal("pwrgit", {
      dispatch: async (name: string, request: { authors?: unknown[] }) => {
        if (name === "graph:lanes") {
          requests.push(request);
          return ok(structuredClone(await nextGraph()));
        }
        if (name === "people:replaceInterest" && request.authors?.length) {
          return ok(structuredClone(nextPeople));
        }
        if (name === "settings:read") return ok({ experimental: { lineageAllBranches: false } });
        return ok({});
      },
      on: (name: string, handler: (payload: unknown) => void) => {
        subscriptions.set(name, handler);
        return () => subscriptions.delete(name);
      }
    });

    const row = () => container.querySelector(".graph-row");
    const render = (selectedWorktreeId: string) => {
      root.render(
        <LineageGraph repoId={repoId} repoName="Widgets" worktreeId={selectedWorktreeId}
          worktreePath="/synthetic/widget" viewingBranch="main" activeEmail=""
          selectedCommits={selected} focusedCommit={hash} revealCommit={null}
          tidyOffered={false} onEditHistory={noop} onCommitsChange={search}
          onOpenCommit={navigate} onRevealWorktree={noop} onRevealCreatedWorktree={noop} />
      );
    };
    await act(async () => render(worktreeId));
    return {
      row, search, navigate, requests,
      async refresh(next: LaneGraph | Promise<LaneGraph>, people = initialPeople, repo = repoId) {
        nextGraph = async () => next;
        nextPeople = people;
        await act(async () => subscriptions.get("graph:changed")?.({ repoId: repo }));
      },
      async switchWorktree(next: LaneGraph, people: Record<string, CommitAuthorPerson>) {
        // App clears search when the selected worktree changes.
        search.mockClear();
        nextGraph = async () => next;
        nextPeople = people;
        await act(async () => render("second-worktree"));
      },
      unmount: async () => act(async () => root.unmount())
    };
  }

  it("commits only changed replies and republishes search only for changed commit content", async () => {
    const initial = graph("Initial widget");
    const people = { [email]: { state: "none", checkedAt: 100 } } as const;
    const view = await mount(initial, people);
    const row = view.row();

    try {
      await view.refresh(graph("Other repository"), people, "other");
      expect(view.requests).toEqual([{ worktreeId, scope: "active", force: false }]);
      await fc.assert(fc.asyncProperty(
        fc.array(fc.tuple(
          fc.constantFrom("Red widget", "Blue widget"),
          fc.option(fc.constantFrom("widget-v1", "widget-v2"), { nil: undefined })
        ), { minLength: 1, maxLength: 6 }),
        async (updates) => {
          let previous = initial;
          await view.refresh(previous);
          for (const [subject, tag] of updates) {
            const next = graph(subject, tag);
            const commitCount = rowCommits.mock.calls.length;
            const searchCount = view.search.mock.calls.length;
            await view.refresh(next);
            expect(view.requests.at(-1)).toEqual({ worktreeId, scope: "active", force: true });
            expect(rowCommits.mock.calls.length - commitCount).toBe(Number(JSON.stringify(next) !== JSON.stringify(previous)));
            expect(view.search.mock.calls.length - searchCount).toBe(Number(subject !== previous.commits[0]?.subject));
            expect(view.search.mock.lastCall?.[0]).toEqual(next.commits);
            expect(view.row()).toBe(row);
            expect(row?.classList.contains("is-selected")).toBe(true);
            expect(row?.textContent).toContain(subject);
            expect(row?.querySelector(".commit-tag__name")?.textContent).toBe(tag);
            previous = next;
          }
        }
      ), { numRuns: 15 });

      await view.refresh(initial);
      const commitsBefore = rowCommits.mock.calls.length;
      await view.refresh(initial);
      expect(rowCommits.mock.calls).toHaveLength(commitsBefore);
      await act(async () => row?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(view.navigate).toHaveBeenCalledWith(hash, view.search.mock.lastCall?.[0][0]?.subject);
    } finally {
      await view.unmount();
    }
  });

  it.each(["before", "after"] as const)(
    "keeps search ready while decoding a switched worktree's avatars with the stale reply %s decode",
    async (staleOrder) => {
      const initial = graph("Initial widget");
      const view = await mount(initial);
      try {
        const stale = deferred<LaneGraph>();
        const decoding = deferred<void>();
        const decode = vi.fn(() => decoding.promise);
        vi.stubGlobal("Image", class { decode = decode; });
        const avatar = `pwrgit-avatar://thumbnail/synthetic-refresh-${staleOrder}`;
        const old = graph("Superseded widget");
        const updated = graph("Latest widget", "widget-v3");
        await view.refresh(stale.promise);
        await view.switchWorktree(updated, { [email]: { state: "linked", identity: { login: "author", avatarUrl: avatar } } });
        expect(decode).toHaveBeenCalledOnce();
        expect(view.search).toHaveBeenCalledExactlyOnceWith(updated.commits);
        expect(view.row()?.textContent).toContain("Initial widget");
        if (staleOrder === "before") await act(async () => stale.resolve(old));
        await act(async () => decoding.resolve());
        if (staleOrder === "after") await act(async () => stale.resolve(old));
        expect(rowCommits.mock.calls.find(([subject]) => subject === "Latest widget")).toEqual(["Latest widget", avatar]);
        expect(view.row()?.querySelector("img")?.getAttribute("src")).toBe(avatar);
        expect(view.search).toHaveBeenCalledExactlyOnceWith(updated.commits);
        expect(view.row()?.textContent).toContain("Latest widget");
        expect(rowCommits.mock.calls.some(([subject]) => subject === "Superseded widget")).toBe(false);
      } finally {
        await view.unmount();
      }
    }
  );

  it("publishes people changes even when the graph and search results are identical", async () => {
    const initial = graph("Initial widget");
    const view = await mount(initial, { [email]: { state: "none", checkedAt: 100 } });
    try {
      const avatar = "data:image/png;base64,synthetic";
      await view.refresh(initial, {
        [email]: { state: "linked", checkedAt: 200, identity: { login: "author", avatarUrl: avatar } }
      });
      expect(view.row()?.querySelector("img")?.getAttribute("src")).toBe(avatar);
      const commitsBefore = rowCommits.mock.calls.length;
      await view.refresh(initial, { [email]: { state: "none", checkedAt: 100 } });
      expect(view.row()?.querySelector("img")?.getAttribute("src")).toBe(avatar);
      expect(rowCommits.mock.calls).toHaveLength(commitsBefore);
      expect(view.search).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });
});
