// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import fc from "fast-check";
import { afterEach, expect, test, vi } from "vitest";
import { ok, type ChangeRequestEntry, type PrSummary, type Repo, type RepositoryStack } from "@pwrgit/shared";
import { useHoverIntent } from "../../lib/hoverIntent";
import { GraphRow } from "../graph/GraphRow";
import { RepoChangeRequestSection } from "../sidebar/RepoChangeRequestSection";
import { StackToolbar } from "./StackToolbar";
import { StackView, StacksSidebar } from "./StackViews";
import { StackNavigationContext, type StackPick } from "./stack-navigation";

const repo: Repo = { id: "orbit", name: "Orbit", path: "/test/orbit", profileId: "test", pinned: false, worktrees: [] };
const scope = "github.com/example/orbit";
const noop = () => undefined;
const makeStack = (height: number, source: RepositoryStack["source"] = "tracked") => ({
  id: "fixture", source, catalogRepository: "github.com:example/orbit", trunk: { branch: "main", head: "a".repeat(40) },
  layers: Array.from({ length: height }, (_, index) => ({
    branch: `branch-${index + 1}`, parent: index ? `branch-${index}` : "main", forgeRepo: scope,
    base: "a".repeat(40), head: "b".repeat(40),
    health: { inSync: false, needsRestack: true, parentMerged: false, needsPush: false, remoteAhead: false, drift: false },
  })),
});

const makePr = (index: number): PrSummary => ({
  number: index + 1, title: `Layer ${index + 1}`, url: `https://example.invalid/pull/${index + 1}`, state: "open", isDraft: false,
  headRefName: `branch-${index + 1}`, checkState: "passing",
});

function Graph({ stack }: { stack: RepositoryStack }) {
  const hoverIntent = useHoverIntent();
  const layer = stack.layers[0];
  return <GraphRow vm={{
    commit: { hash: layer.head!, shortHash: "bbbbbbb", subject: "First commit", parents: [], authorName: "Avery",
      authorEmail: "avery@example.invalid", committedAt: "2026-01-01T00:00:00Z", isMerge: false },
    row: { lane: 0, top: [], bottom: [] }, refs: [layer.branch], remoteRefs: [], isHead: true, isHeadOnly: true, isMine: true, defaultBranch: "main",
  }} laneCount={1} now={0} selected={false} focused={false} contextOpen={false} flashing={false} hoverIntent={hoverIntent}
    onOpen={noop} onShowContext={noop} onHideContext={noop} onFocusContext={() => false} onOpenContextMenu={noop}
    stackRepoId={repo.id} stackPositions={new Map([[layer.branch, { stack, layer, index: 1 }]])} />;
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.restoreAllMocks();
});
async function render(stack: RepositoryStack, { writable = true, initial = false, recent = false, extra = false }:
  { writable?: boolean; initial?: boolean; recent?: boolean; extra?: boolean } = {}) {
  cleanup?.();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); cleanup = undefined; };
  const pick = { repoId: repo.id, stack };
  const entries: ChangeRequestEntry[] = stack.layers.flatMap(layer => layer.pr?.state === "open"
    ? [{ pr: layer.pr, forgeRepo: scope, remote: "origin", location: { kind: "local", branch: layer.branch } }] : []);
  if (extra) entries.splice(1, 0, { pr: { ...makePr(99), title: "Unstacked" }, forgeRepo: scope, remote: "origin",
    location: { kind: "local", branch: "unstacked" } });
  const snapshot = { stacks: [stack], schemaVersion: 1, readOnly: !writable };
  localStorage.setItem("pwrgit.changeRequestsOpen.orbit", "1");
  localStorage.setItem("pwrgit.changeRequestsSort.orbit", recent ? "recent" : "stack");
  Object.assign(window, { pwrgit: {
    dispatch: async (name: string) => ok(name === "stack:list" ? snapshot : {
      forge: "github", fetchedAt: 1, truncated: false, entries, remotes: [
        { forgeRepo: scope, name: "origin", path: "example/orbit", forge: "github", truncated: false, fetchedAt: 1 }
      ],
    }), on: () => noop,
  } });
  function Fixture() {
    const [selected, select] = useState<StackPick | null>(initial ? pick : null);
    return <StackNavigationContext.Provider value={{ pick: selected, select }}>
      <Graph stack={stack} />
      <div data-list=""><RepoChangeRequestSection repo={repo} now={0} focusedWorktree={null} onRevealWorktree={noop}
        onCreateWorktree={noop} onOpenBrowser={noop} /></div>
      <div data-index=""><StacksSidebar repo={repo} stacks={[stack]} writable={writable} /></div>
      {selected && <StackView stack={stack} repoId={repo.id} writable={writable} onClose={() => select(null)}
        toolbar={<StackToolbar stack={stack} disabled={!writable} onPlan={noop} />} />}
    </StackNavigationContext.Provider>;
  }
  await act(async () => root.render(<Fixture />));
  return container;
}
const click = (el: Element | null) => act(() => (el as HTMLElement | null)?.click());
const order = (el: Element, selector: string) =>
  Array.from(el.querySelectorAll(selector), member => Number(member.getAttribute("data-stack-position")));
const showPopover = (el: Element | null) => {
  if (!el) throw new Error("The stack popover trigger is missing");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(8, 8, 100, 20));
  click(el);
};

test("R1 orders positions top-first with trunk immediately below position 1", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async height => {
    const stack = makeStack(height);
    const el = await render({ ...stack, layers: stack.layers.map((layer, index) => ({ ...layer, pr: makePr(index) })) }, { initial: true });
    const expected = stack.layers.map(layer => layer.branch).reverse();
    expect(Array.from(el.querySelectorAll(".stack-view__cards [data-stack-branch]"), row => row.getAttribute("data-stack-branch"))).toEqual(expected);
    expect(el.querySelector(".stack-view__cards > :last-child")?.textContent).toContain("main");
    const descending = Array.from({ length: height }, (_, index) => height - index);
    expect(order(el, "[data-list] .stack-group [data-stack-position]")).toEqual(descending);
    expect(el.querySelector("[data-list] .stack-group > :last-child")?.textContent).toContain("main");
    showPopover(el.querySelector("[data-list] .stack-group__caption"));
    const popover = el.querySelector(".stack-popover")!;
    expect(order(popover, "[data-stack-position]")).toEqual(descending);
    expect(popover.querySelector(".stack-popover__list > :last-child")?.textContent).toContain("main");
    const indexRow = el.querySelector("[data-index] [data-nav-anchor^='stack:']")!;
    expect(order(indexRow, ".stack-train [data-stack-position]").reverse()).toEqual(descending);
    expect(indexRow.querySelector(".stack-train .stack-node")?.getAttribute("data-stack-state")).toBe("trunk");
    expect(Array.from(indexRow.getAttribute("aria-label")!.matchAll(/(\d+) of/g), match => Number(match[1]))).toEqual(descending);
    expect(indexRow.getAttribute("aria-label")).toMatch(/trunk main$/);
  }), { numRuns: 12 });
});

test("R2 opens the stack view only after explicit stack navigation", async () => {
  const gesture = fc.constantFrom("gutter", "commit", "hover", "focus", "arrow", "refresh", "repo", "back", "index", "popover");
  await fc.assert(fc.asyncProperty(fc.array(gesture, { minLength: 1, maxLength: 9 }), async gestures => {
    const stack = makeStack(2);
    const withPr = { ...stack, layers: stack.layers.map((layer, index) => ({ ...layer, pr: makePr(index) })) };
    let el = await render(withPr);
    let open = false;
    for (const gesture of gestures) {
      const graph = el.querySelector(".graph-row");
      if (gesture === "gutter") click(graph?.querySelector("button.stack-graph-bracket") ?? graph?.querySelector(".graph-lanes-clip") ?? null);
      if (gesture === "commit") click(graph);
      if (gesture === "hover") act(() => graph?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      if (gesture === "focus") act(() => (graph as HTMLElement | null)?.focus());
      if (gesture === "arrow") act(() => el.querySelector(".ref-cr-row")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
      if (gesture === "refresh") await act(async () => { window.dispatchEvent(new Event("focus")); });
      if (gesture === "repo") { el = await render(withPr); open = false; }
      if (gesture === "back") { click(el.querySelector('[aria-label="Back to worktree"]')); open = false; }
      if (gesture === "index") {
        click(el.querySelector("[data-index] [data-nav-anchor^='stack:']"));
        open = true;
      }
      if (gesture === "popover") {
        const chip = graph?.querySelector(".stack-position") ?? null;
        if (el.querySelector(".stack-popover")) click(el.querySelector('[aria-label="Close stack popover"]'));
        showPopover(chip);
        expect(Boolean(el.querySelector(".stack-view"))).toBe(open);
        const command = Array.from(el.querySelectorAll("button")).find(button => button.textContent === "Open stack view");
        expect(command).toBeDefined();
        click(command!);
        open = true;
      }
      expect(Boolean(el.querySelector(".stack-view")), gesture).toBe(open);
    }
  }), { numRuns: 24, examples: [[["gutter"]], [["focus", "arrow", "hover", "refresh", "popover", "back", "repo", "index"]]] });
});

test("R3 uses one PR state for the card chip and stack nodes", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("passing", "pending", "failing", "unknown"), fc.boolean(), fc.boolean(),
    async (checkState, isDraft, conflict) => {
      const stack = makeStack(1);
      const layer = { ...stack.layers[0], pr: { ...makePr(0), checkState, isDraft,
        mergeState: conflict ? "conflicting" as const : "unknown" as const } };
      const model = { ...stack, layers: [layer] };
      const el = await render(model);
      const state = isDraft ? "draft" : conflict ? "conflicting" : checkState === "unknown" ? "open" : checkState;
      expect(el.querySelector("[data-list] .ref-cr-row [data-stack-state]")?.getAttribute("data-stack-state")).toBe(state);
      expect(el.querySelector("[data-list] .stack-group [data-stack-position] .stack-node")?.getAttribute("data-stack-state")).toBe(state);
      showPopover(el.querySelector("[data-list] .stack-group__caption"));
      expect(el.querySelector(".stack-popover .stack-node")?.getAttribute("data-stack-state")).toBe(state);
      const fallback = await render(model, { recent: true });
      expect(fallback.querySelector(".stack-ladder .stack-node")?.getAttribute("data-stack-state")).toBe(state);
    }), { numRuns: 18 });
});

test("R4 groups all stack layers exactly once, including ghosts", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("open", "merged", "closed", "none"), { maxLength: 6 }), async states => {
    const stack = makeStack(states.length + 1);
    const layers = stack.layers.map((layer, index) => {
      const state = index === 0 ? "open" : states[index - 1];
      return state === "none" ? layer : { ...layer, pr: { ...makePr(index), state } };
    });
    const el = await render({ ...stack, layers }, { extra: true });
    const group = el.querySelector("[data-list] .stack-group");
    expect(group).not.toBeNull();
    expect(Array.from(group!.querySelectorAll("[data-stack-position]"), row => Number(row.getAttribute("data-stack-position"))))
      .toEqual(layers.map((_, index) => index + 1).reverse());
    const open = layers.filter(layer => "pr" in layer && layer.pr.state === "open").length;
    expect(group!.querySelectorAll('[role="treeitem"]')).toHaveLength(open);
    expect(group!.querySelectorAll('.stack-group__ghost')).toHaveLength(layers.length - open);
    expect(group!.textContent).not.toContain("Unstacked");
    expect(el.querySelectorAll("[data-list] .ref-cr-row")).toHaveLength(open + 1);
  }), { numRuns: 12 });
});

test("R5 names GitHub-linked stacks by the GitHub stack number", async () => {
  const stack = { ...makeStack(2, "inferred"), githubNumber: 4235 };
  const el = await render(stack, { initial: true });
  const header = el.querySelector(".stack-view__header")!;
  expect(header.textContent).toContain("Stack #4235");
  expect(header.textContent).toContain("linked on GitHub");
  expect(header.textContent).not.toMatch(/Inferred|Adopt stack/);
});

test("R6 shows amber for a plannable action only", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
    async (tracked, writable, local, merged) => {
      const stack = makeStack(2, tracked ? "tracked" : "inferred");
      const layers = stack.layers.map((layer, index) => ({
        ...layer, local, syncReady: index === 1 && merged, pr: makePr(index),
        health: { ...layer.health, needsRestack: index === 1 && !merged, parentMerged: index === 1 && merged }
      }));
      const el = await render({ ...stack, layers }, { writable, initial: true });
      const actionable = tracked && writable && local;
      expect(Boolean(el.querySelector(".stack-health-badge--stale"))).toBe(actionable);
      expect(Boolean(el.querySelector(".stack-view .has-action"))).toBe(actionable);
      showPopover(el.querySelector(".stack-group__caption"));
      const footer = el.querySelector(".stack-popover__footer");
      expect(footer?.textContent?.includes(merged ? "Sync stack…" : "Restack stack…")).toBe(actionable);
    }), { examples: [[false, false, true, false], [true, false, true, false], [true, true, true, true]], numRuns: 12 });
});
