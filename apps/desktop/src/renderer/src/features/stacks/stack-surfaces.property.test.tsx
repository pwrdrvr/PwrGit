// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import fc from "fast-check";
import { afterEach, expect, test, vi } from "vitest";
import { ok, stackPositionForPr, type ChangeRequestEntry, type PrSummary, type Repo, type RepositoryStack, type StackLayer } from "@pwrgit/shared";
import { useHoverIntent } from "../../lib/hoverIntent";
import { ChangeRequestSelectionContext } from "../change-request/change-request-selection";
import { GraphRow } from "../graph/GraphRow";
import { PrChip } from "../sidebar/PrChip";
import { PrStatusCard } from "../sidebar/PrStatusCard";
import { renderToStaticMarkup } from "react-dom/server";
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
async function render(stack: RepositoryStack, { writable = true, initial = false, recent = false, extra = false, listed, selectedKey = null, stacks = [stack] }:
  { writable?: boolean; initial?: boolean; recent?: boolean; extra?: boolean; listed?: readonly PrSummary[]; selectedKey?: string | null; stacks?: RepositoryStack[] } = {}) {
  cleanup?.();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); cleanup = undefined; };
  const pick = { repoId: repo.id, stack };
  const list = listed ?? stack.layers.flatMap(layer => layer.pr?.state === "open" ? [layer.pr] : []);
  const entries: ChangeRequestEntry[] = list.map(pr => ({
    pr, forgeRepo: scope, remote: "origin", location: { kind: "local", branch: pr.headRefName! },
  }));
  if (extra) entries.splice(1, 0, { pr: { ...makePr(99), title: "Unstacked" }, forgeRepo: scope, remote: "origin",
    location: { kind: "local", branch: "unstacked" } });
  const snapshot = { stacks, schemaVersion: 1, readOnly: !writable };
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
    return <ChangeRequestSelectionContext.Provider value={{ selectedKey, select: noop, clear: noop }}>
    <StackNavigationContext.Provider value={{ pick: selected, select }}>
      <Graph stack={stack} />
      <div data-list=""><RepoChangeRequestSection repo={repo} now={0} focusedWorktree={null} onRevealWorktree={noop}
        onCreateWorktree={noop} onOpenBrowser={noop} /></div>
      <div data-index=""><StacksSidebar repo={repo} stacks={[stack]} writable={writable} /></div>
      {selected && <StackView stack={stack} repoId={repo.id} writable={writable} onClose={() => select(null)}
        toolbar={<StackToolbar stack={stack} disabled={!writable} onPlan={noop} />} />}
    </StackNavigationContext.Provider>
    </ChangeRequestSelectionContext.Provider>;
  }
  await act(async () => root.render(<Fixture />));
  return container;
}
const click = (el: Element | null) => act(() => (el as HTMLElement | null)?.click());
const order = (el: Element, selector: string) =>
  Array.from(el.querySelectorAll(selector), member => Number(member.getAttribute("data-stack-position")));
const showPopover = (el: Element | null, via: "click" | "space" = "click") => {
  if (!el) throw new Error("The stack popover trigger is missing");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(8, 8, 100, 20));
  if (via === "click") click(el);
  else act(() => {
    const button = el as HTMLButtonElement;
    button.focus();
    const pressed = button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    const released = button.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }));
    // jsdom dispatches the keys but leaves native button activation to the caller.
    if (pressed && released) button.click();
  });
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
    // The Stacks row counts states (R8); its order lives in its accessible name.
    expect(indexRow.querySelector(".stack-train")).toBeNull();
    expect(Array.from(indexRow.getAttribute("aria-label")!.matchAll(/(\d+) of/g), match => Number(match[1]))).toEqual(descending);
    expect(indexRow.getAttribute("aria-label")).toMatch(/trunk main$/);
  }), { numRuns: 12 });
});

test("R10 closed stacks change neither the index count, rows nor auto-expansion", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom("open", "closed", "merged"), { minLength: 1, maxLength: 5 }),
    async states => {
      const stacks: RepositoryStack[] = states.map((state, index) => {
        const stack = makeStack(1, "inferred");
        const pr = { ...makePr(index), state, headRefName: `history-${index}` };
        return { ...stack, id: String(index), githubNumber: 4000 + index,
          ...(state === "open" ? {} : { closed: state }),
          layers: [{ ...stack.layers[0], branch: pr.headRefName, pr }] };
      });
      const active = stacks.filter((_stack, index) => states[index] === "open");
      const el = await render(stacks[0], { stacks, listed: active.map(stack => stack.layers[0].pr!) });
      const index = el.querySelector("[data-list] .stack-sidebar");
      if (!active.length) {
        expect(index).toBeNull();
        return;
      }
      const heading = index?.querySelector(".ref-section__head");
      expect(heading?.querySelector(".ref-section__count")?.textContent).toBe(String(active.length));
      expect(heading?.getAttribute("aria-expanded")).toBe("false");
      await click(heading ?? null);
      expect(Array.from(index!.querySelectorAll("button[data-nav-anchor^='stack:']"), button =>
        button.getAttribute("data-nav-anchor"))).toEqual(
        active.map(stack => `stack:${repo.id}:${stack.id}`));
    }), { numRuns: 20, examples: [[["merged"]], [["open", "closed"]]] });
});

test("R2 opens the stack view only after explicit stack navigation", async () => {
  const gesture = fc.constantFrom("gutter", "commit", "hover", "focus", "arrow", "refresh", "repo", "back", "index", "popover", "caption click", "caption Space", "ghost click", "index hover");
  await fc.assert(fc.asyncProperty(fc.array(gesture, { minLength: 1, maxLength: 9 }), async gestures => {
    const stack = makeStack(3);
    const withPr = { ...stack, layers: stack.layers.map((layer, index) => index === 2 ? layer : { ...layer, pr: makePr(index) }) };
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
      if (gesture === "index hover") {
        const row = el.querySelector("[data-index] [data-nav-anchor^='stack:']")!;
        const popover = el.querySelector(".stack-popover");
        act(() => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
        expect(el.querySelector(".stack-popover")).toBe(popover);
      }
      if (gesture === "caption click" || gesture === "caption Space" || gesture === "ghost click") {
        if (el.querySelector(".stack-popover")) click(el.querySelector('[aria-label="Close stack popover"]'));
        const trigger = el.querySelector(gesture === "ghost click" ? ".stack-group__ghost" : ".stack-group__caption");
        showPopover(trigger, gesture === "caption Space" ? "space" : "click");
        expect(Boolean(el.querySelector(".stack-view")), gesture).toBe(open);
        expect(el.querySelector(".stack-popover"), gesture).not.toBeNull();
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
  }), { numRuns: 24, examples: [[["gutter"]], [["caption click"]], [["caption Space", "ghost click", "index hover"]], [["focus", "arrow", "hover", "refresh", "popover", "back", "repo", "index"]]] });
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
    }), { numRuns: 18 });
});

// Out of stack order there is no rail to hang a node on, so a stacked row is
// an ordinary row plus its position: one status mark (the chip's own dot), no
// stack nodes, and an i/n tag that opens the stack with this PR marked.
test("R7 a stacked row outside its group shows only its position", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }).chain(height =>
    fc.tuple(fc.constant(height), fc.integer({ min: 1, max: height }))), async ([height, opened]) => {
    const stack = makeStack(height);
    const el = await render({ ...stack, layers: stack.layers.map((layer, index) => ({ ...layer, pr: makePr(index) })) },
      { recent: true });
    const rows = Array.from(el.querySelectorAll("[data-list] .ref-cr-row"));
    expect(rows).toHaveLength(height);
    for (const row of rows) {
      const index = Number(/^#(\d+)/.exec(row.getAttribute("aria-label") ?? "")?.[1]);
      expect(row.querySelectorAll(".stack-node")).toHaveLength(0);
      expect(row.querySelectorAll(".pr-chip__dot")).toHaveLength(1);
      expect(row.querySelector(".stack-position")?.textContent).toBe(`${index}/${height}`);
    }
    const tag = rows.find(row => row.getAttribute("aria-label")?.startsWith(`#${opened} `))!.querySelector(".stack-position");
    showPopover(tag);
    const marked = Array.from(document.querySelectorAll(".stack-popover__member"))
      .filter(member => member.textContent?.includes("This PR"));
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain(`Layer ${opened}`);
  }), { numRuns: 12 });
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

test("stack cards badge only facts that need attention", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("passing", "failing", "pending", "unknown"),
    fc.boolean(),
    fc.nat(5),
    async (checkState, conflicting, distance) => {
      const stack = makeStack(2);
      const layers = stack.layers.map((layer, index) => ({
        ...layer,
        pr: { ...makePr(index), checkState, mergeState: conflicting ? "conflicting" as const : "mergeable" as const },
        behindParent: distance,
        health: { ...layer.health, needsRestack: false, inSync: distance === 0 },
      }));
      const el = await render({ ...stack, layers }, { initial: true });
      const expected = [
        ...(checkState === "failing" ? ["checks failing"] : checkState === "pending" ? ["checks running"] : []),
        ...(conflicting ? ["merge conflict"] : []),
      ];
      const badges = (position: number) => Array.from(
        el.querySelectorAll(`.stack-view [data-stack-position="${position}"] .stack-health-badge`),
        badge => badge.textContent
      );
      expect(badges(2)).toEqual(expected);
      expect(badges(1)).toEqual([...expected, ...(distance > 0 ? [`main +${distance}`] : [])]);
    }
  ), { examples: [["passing", false, 0]], numRuns: 16 });
});

test("open-list and stack updates in either order never duplicate a reopened PR", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.boolean(), async (height, listFirst) => {
    const stack = makeStack(height);
    const all = stack.layers.map((_, index) => makePr(index));
    for (const [listed, reopened] of (listFirst ? [[false, false], [true, false], [true, true]] : [[false, false], [false, true], [true, true]])) {
      const layers = stack.layers.map((layer, index) => ({
        ...layer, pr: index === 0 && !reopened ? { ...all[index], state: "closed" as const } : all[index],
      }));
      const el = await render({ ...stack, layers }, { listed: listed ? all : all.slice(1) });
      const rows = [...el.querySelectorAll("[data-list] .ref-cr-row")];
      expect(rows).toHaveLength(listed ? height : height - 1);
      expect(new Set(rows.map(row => row.getAttribute("data-nav-anchor"))).size).toBe(rows.length);
      if (listed) expect(el.querySelector("[data-list] .stack-group__ghost")).toBeNull();
    }
  }), { numRuns: 8 });
});

test("the tag's branch takes precedence over the selected PR and owns Escape", async () => {
  const stack = makeStack(2);
  const layers = stack.layers.map((layer, index) => ({ ...layer, pr: makePr(index) }));
  const el = await render({ ...stack, layers }, { recent: true, selectedKey: `${repo.id}\n${scope}#2` });
  const tag = [...el.querySelectorAll<HTMLButtonElement>("[data-list] .stack-position")].find(button => button.textContent === "1/2")!;
  act(() => tag.focus());
  showPopover(tag);
  const current = el.querySelectorAll(".stack-popover [aria-current='true']");
  expect(current).toHaveLength(1);
  expect(current[0]?.textContent).toContain("Layer 1");
  expect(document.activeElement).toBe(current[0]);
  const last = el.querySelector<HTMLButtonElement>(".stack-popover__footer button:last-child")!;
  act(() => last.focus());
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => last.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close stack popover");
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => document.activeElement?.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(el.querySelector(".stack-popover")).toBeNull();
  expect(document.activeElement).toBe(tag);
});

test("an invalid recorded base anywhere in the replay range suppresses Restack", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async height => {
    const stack = makeStack(height);
    const layers = stack.layers.map((layer, index) => ({
      ...layer, pr: makePr(index), baseIsAncestor: index + 1 !== height,
    }));
    const el = await render({ ...stack, layers }, { initial: true });
    expect(el.querySelector(".stack-health-badge--stale")).toBeNull();
    showPopover(el.querySelector(".stack-group__caption"));
    expect(el.querySelector(".stack-popover__footer")?.textContent).not.toContain("Restack");
  }), { numRuns: 8 });
});

// R8 (board turn 8): a Stacks row counts its members by state, worst first,
// and pointing at a count marks exactly those members, top first. The oracle
// reads the raw PR fields, not the presentation code under test.
const BUCKET_ORDER = ["failing", "failing-running", "conflicting", "pending", "passing", "open", "draft", "no-pr", "closed", "merged"];
const bucketOracle = (pr: PrSummary | undefined) => !pr ? "no-pr" : pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed"
  : pr.isDraft ? "draft" : pr.mergeState === "conflicting" ? "conflicting"
  : pr.checkState === "failing" ? pr.checksStillRunning ? "failing-running" : "failing"
  : pr.checkState === "pending" ? "pending" : pr.checkState === "passing" ? "passing" : "open";
const hover = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });

test("R8 a Stacks row counts states worst first, and a count marks exactly its members", async () => {
  const layerPr = fc.option(fc.record({
    state: fc.constantFrom("open", "open", "open", "merged", "closed"), isDraft: fc.boolean(),
    conflict: fc.boolean(), checkState: fc.constantFrom("passing", "pending", "failing", "unknown"), running: fc.boolean(),
  }), { nil: undefined });
  await fc.assert(fc.asyncProperty(fc.array(layerPr, { minLength: 1, maxLength: 7 }), fc.nat(), async (shapes, pick) => {
    const stack = makeStack(shapes.length);
    const layers: StackLayer[] = stack.layers.map((layer, index) => {
      const shape = shapes[index];
      return shape ? { ...layer, pr: { ...makePr(index), state: shape.state, isDraft: shape.isDraft,
        mergeState: shape.conflict ? "conflicting" as const : "unknown" as const, checkState: shape.checkState,
        checksStillRunning: shape.running } } : layer;
    });
    const el = await render({ ...stack, layers });
    const row = el.querySelector("[data-index] [data-nav-anchor^='stack:']")!;
    const counts = Array.from(row.querySelectorAll(".stack-tally__count"), count =>
      [count.getAttribute("data-bucket")!, Number(count.textContent)] as const);
    const expected = new Map<string, number>();
    for (const layer of layers) expected.set(bucketOracle(layer.pr), (expected.get(bucketOracle(layer.pr)) ?? 0) + 1);
    expect(counts).toEqual(BUCKET_ORDER.filter(bucket => expected.has(bucket)).map(bucket => [bucket, expected.get(bucket)]));
    expect(counts.reduce((sum, [, count]) => sum + count, 0)).toBe(layers.length);
    expect(row.querySelector(".stack-train, .stack-node[data-stack-state='trunk']")).toBeNull();

    const [bucket] = counts[pick % counts.length];
    hover(row.querySelectorAll(".stack-tally__count")[pick % counts.length]);
    const card = document.querySelector(".stack-tally-card")!;
    const marked = Array.from(card.querySelectorAll("li[data-mark='on'] .stack-tally-card__n"), n => n.textContent);
    const members = layers.map((layer, index) => ({ layer, index: index + 1 })).reverse();
    expect(marked).toEqual(members.filter(({ layer }) => bucketOracle(layer.pr) === bucket).map(({ index }) => `${index}/${layers.length}`));
    expect(card.querySelector("li:last-child")?.textContent).toContain("main");
  }), { numRuns: 30 });
});

// R9, UI half (board turn 9): membership belongs to the PR. A merged PR in a
// closed stack, whose branch is gone, still shows its i/n beside its chip in
// Lineage and in a chip that knows no repository, and its hover card lists
// the stack with it marked. A PR in no stack shows neither.
test("R9 a merged PR whose branch is gone still shows its stack beside its chip and in its card", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 7 }).chain(height =>
    fc.tuple(fc.constant(height), fc.integer({ min: 1, max: height }))), async ([height, at]) => {
    const base = makeStack(height);
    const layers = base.layers.map((layer, index) => ({ ...layer, local: false,
      pr: { ...makePr(index), state: "merged" as const, repoPath: "example/orbit" } }));
    const stack: RepositoryStack = { ...base, githubNumber: 4231, closed: "merged", layers };
    await render(stack, { listed: [] });
    const member = layers[at - 1].pr;
    const outsider = { ...makePr(200), state: "merged" as const, repoPath: "example/orbit" };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    function Lineage({ pr }: { pr: PrSummary }) {
      const hoverIntent = useHoverIntent();
      return <GraphRow vm={{
        commit: { hash: "c".repeat(40), shortHash: "ccccccc", subject: pr.title, parents: [], authorName: "Avery",
          authorEmail: "avery@example.invalid", committedAt: "2026-01-01T00:00:00Z", isMerge: false },
        row: { lane: 0, top: [], bottom: [] }, refs: [], remoteRefs: [], isHead: false, isHeadOnly: false, isMine: true, defaultBranch: "main",
        pullRequest: pr,
      }} laneCount={1} now={0} selected={false} focused={false} contextOpen={false} flashing={false} hoverIntent={hoverIntent}
        onOpen={noop} onShowContext={noop} onHideContext={noop} onFocusContext={() => false} onOpenContextMenu={noop}
        stackRepoId={repo.id} stackPositions={new Map()} />;
    }
    await act(async () => root.render(<>
      <div data-lineage=""><Lineage pr={member} /></div>
      <div data-bare=""><PrChip pr={member} /></div>
      <div data-outsider=""><Lineage pr={outsider} /><PrChip pr={outsider} /></div>
    </>));
    try {
      expect(host.querySelector("[data-lineage] .pr-chip + .stack-position")?.textContent).toBe(`${at}/${height}`);
      expect(host.querySelector("[data-bare] .pr-chip + .stack-position")?.textContent).toBe(`${at}/${height}`);
      expect(host.querySelector("[data-outsider] .stack-position")).toBeNull();
      const position = stackPositionForPr([stack], member)!;
      const card = document.createElement("div");
      card.innerHTML = renderToStaticMarkup(<PrStatusCard pr={member} stackPosition={position} />);
      const rows = Array.from(card.querySelectorAll(".stack-card-section__list li:not(.stack-card-section__more)"));
      expect(card.querySelector(".stack-card-section__title")?.textContent).toContain("Stack #4231");
      expect(card.querySelector(".stack-card-section__title")?.textContent).toContain("merged into main");
      expect(rows.at(-1)?.textContent).toContain("main");
      const current = card.querySelectorAll("[aria-current='true']");
      expect(current).toHaveLength(1);
      expect(current[0].textContent).toContain(`${at}/${height}`);
      expect(current[0].textContent).toContain(`#${member.number}`);
      expect(rows.length - 1).toBe(Math.min(height, 5));
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  }), { numRuns: 14 });
});
