// @vitest-environment jsdom
import type { Commit } from "@pwrgit/shared";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphRow, type GraphRowVM } from "./GraphRow";

const commit: Commit = {
  hash: "abc1234567890",
  shortHash: "abc1234",
  parents: ["parent"],
  subject: "Keep remote branch labels inside their chips",
  authorName: "Harold Hunt",
  authorEmail: "harold@example.com",
  committedAt: "2026-08-06T12:00:00.000Z",
  isMerge: false
};

describe("GraphRow remote ref chips", () => {
  it("wraps remote names in the shrink-safe ellipsis span", () => {
    const name = "origin/agent/messaging-response-identity-labels";
    const markup = renderToStaticMarkup(
      <GraphRow
        vm={{
          commit,
          row: { lane: 1, top: [], bottom: [] },
          refs: [],
          remoteRefs: [name],
          isHead: false,
          isHeadOnly: false,
          isMine: true,
          defaultBranch: "main"
        }}
        laneCount={2}
        hoverIntent={{
          arm: () => undefined,
          cancel: () => undefined,
          immediate: () => undefined,
          cardClosed: () => undefined
        }}
        now={new Date("2026-08-06T12:01:00.000Z").getTime()}
        selected={false}
        focused={false}
        contextOpen={false}
        flashing={false}
        onToggle={() => undefined}
        onOpen={() => undefined}
        onShowContext={() => undefined}
        onHideContext={() => undefined}
        onFocusContext={() => false}
        onOpenContextMenu={() => undefined}
      />
    );

    expect(markup).toContain(
      `<span class="ref-chip__name">${name}</span>`
    );
  });
});

const vm = (over: Partial<GraphRowVM>): GraphRowVM => ({
  commit: { ...commit, authorName: "Wilhelmina Castellanos" },
  row: { lane: 0, top: [], bottom: [] },
  refs: [],
  remoteRefs: [],
  isHead: false,
  isHeadOnly: false,
  isMine: false,
  defaultBranch: "main",
  ...over
});
const props = (
  row: GraphRowVM,
  authorAvatarUrl?: string
): ComponentProps<typeof GraphRow> => ({
  vm: row,
  authorAvatarUrl,
  laneCount: 1,
  hoverIntent: {
    arm: () => undefined,
    cancel: () => undefined,
    immediate: () => undefined,
    cardClosed: () => undefined
  },
  now: new Date("2026-08-06T12:01:00.000Z").getTime(),
  selected: false,
  focused: false,
  contextOpen: false,
  flashing: false,
  onToggle: () => undefined,
  onOpen: () => undefined,
  onShowContext: () => undefined,
  onHideContext: () => undefined,
  onFocusContext: () => false,
  onOpenContextMenu: () => undefined
});

describe("GraphRow author", () => {
  /** Park the pointer on the author and read the card it opens, if any. */
  async function hoverAuthor(row: GraphRowVM): Promise<{
    text: string;
    tooltip: string | null;
  }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<GraphRow {...props(row)} />));
    const author = container.querySelector<HTMLElement>(".commit-author")!;
    await act(async () => {
      author.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const tooltip =
      document.querySelector('[role="tooltip"]')?.textContent ?? null;
    await act(async () => root.unmount());
    container.remove();
    return { text: author.textContent ?? "", tooltip };
  }

  // The name ellipsizes when the meta line runs short (app.css
  // `.commit-author`), so the card is the only place the rest of it is.
  it("carries the full name on hover, since the row may ellipsize it", async () => {
    await expect(hoverAuthor(vm({}))).resolves.toEqual({
      text: "Wilhelmina Castellanos",
      tooltip: "Wilhelmina Castellanos"
    });
  });

  it("opens no card over your own commits' short 'you'", async () => {
    await expect(hoverAuthor(vm({ isMine: true }))).resolves.toEqual({
      text: "you",
      tooltip: null
    });
  });

  const avatar = (row: GraphRowVM, url?: string): string =>
    renderToStaticMarkup(<GraphRow {...props(row, url)} />);

  it("paints the proven avatar over the author's initials", () => {
    const url =
      "pwrgit-avatar://thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=1";
    const markup = avatar(vm({}), url);
    expect(markup).toContain(
      '<span class="commit-byline__avatar-initials">WC</span>'
    );
    expect(markup).toContain(`src="${url}"`);
  });

  it("falls back to initials alone with no proven avatar", () => {
    const markup = avatar(vm({}));
    expect(markup).toContain(
      '<span class="commit-byline__avatar-initials">WC</span>'
    );
    expect(markup).not.toContain("commit-byline__avatar-image");
  });

  // The byline keeps the width its name gave up (app.css `.commit-byline`),
  // so anything after it would sit behind a gap.
  it("ends the meta line with the byline, after the merge tag", () => {
    const markup = avatar(vm({ commit: { ...commit, isMerge: true } }));
    expect(markup.indexOf(">merge<")).toBeGreaterThan(-1);
    expect(markup.indexOf(">merge<")).toBeLessThan(
      markup.indexOf('class="commit-byline"')
    );
  });
});

describe("GraphRow chip strip", () => {
  const PILL = 20;
  const FLOOR = 40;

  /** jsdom lays nothing out, so stand in for flex: the strip is `available`
   *  wide and its children sit left to right with no gap, each at its chip's
   *  natural width. A squeezed chip takes what is left, down to FLOOR — what
   *  `.ref-chip.is-squeezed` does in app.css. */
  function layOut(available: number, natural: Record<string, number>): void {
    const widthOf = (el: Element): number => {
      if (el.classList.contains("ref-chip--more")) return PILL;
      const name = el.querySelector(".ref-chip__name")?.textContent ?? "";
      const width = natural[name] ?? 0;
      if (!el.classList.contains("is-squeezed")) return width;
      let others = 0;
      for (const sibling of el.parentElement?.children ?? []) {
        if (sibling !== el) others += widthOf(sibling);
      }
      return Math.min(width, Math.max(FLOOR, available - others));
    };
    const rect = (left: number, width: number): DOMRect =>
      ({
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + width,
        bottom: 17,
        width,
        height: 17,
        toJSON: () => ({})
      }) as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const strip = this.closest(".ref-chips");
        if (strip === null) return rect(0, 0);
        if (this === strip) return rect(0, available);
        let left = 0;
        for (const slot of strip.children) {
          // A chip's parts (name, PR chip, worktree button) share its box.
          if (slot.contains(this)) return rect(left, widthOf(slot));
          left += widthOf(slot);
        }
        return rect(0, 0);
      }
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function strip(row: GraphRowVM): Promise<{
    chips: string[];
    squeezed: string[];
    pill: string | null;
    folded: boolean;
    spoken: string | null;
    tooltip: string | null;
  }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<GraphRow {...props(row)} />));
    const el = container.querySelector<HTMLElement>(".ref-chips")!;
    await act(async () => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const next = el.nextElementSibling;
    const result = {
      chips: [...el.querySelectorAll(".ref-chip__name")].map((n) => n.textContent ?? ""),
      squeezed: [...el.querySelectorAll(".ref-chip.is-squeezed .ref-chip__name")].map(
        (n) => n.textContent ?? ""
      ),
      pill: el.querySelector(".ref-chip--more")?.textContent ?? null,
      folded: el.classList.contains("is-folded"),
      spoken: next?.classList.contains("a11y-sr-only") ? next.textContent : null,
      tooltip: document.querySelector('[role="tooltip"]')?.textContent ?? null
    };
    await act(async () => root.unmount());
    container.remove();
    return result;
  }

  const tipped = vm({
    refs: ["feature/lane-g"],
    remoteRefs: ["origin/feature/lane-h"]
  });
  const widths = { "feature/lane-g": 120, "origin/feature/lane-h": 150 };

  it("shows every chip, and no pill, when the row has room", async () => {
    layOut(400, widths);
    await expect(strip(tipped)).resolves.toMatchObject({
      chips: ["feature/lane-g", "origin/feature/lane-h"],
      squeezed: [],
      pill: null,
      spoken: null
    });
  });

  it("folds a chip that doesn't fit whole into +N, and still names it", async () => {
    layOut(200, widths);
    await expect(strip(tipped)).resolves.toEqual({
      chips: ["feature/lane-g"],
      squeezed: [],
      pill: "+1",
      folded: false,
      spoken: "1 more branch: origin/feature/lane-h",
      tooltip: "feature/lane-g\norigin/feature/lane-h"
    });
  });

  it("ellipsizes the last chip standing before folding it", async () => {
    // 120 + a 20px pill won't fit in 100, but the chip squeezed to 80 will.
    layOut(100, widths);
    await expect(strip(tipped)).resolves.toMatchObject({
      chips: ["feature/lane-g"],
      squeezed: ["feature/lane-g"],
      pill: "+1"
    });
  });

  it("folds the last chip too when even its floor overflows", async () => {
    // FLOOR 40 + PILL 20 > 50: the pill alone is left, and it names both.
    layOut(50, widths);
    await expect(strip(tipped)).resolves.toEqual({
      chips: [],
      squeezed: [],
      pill: "+2",
      folded: true,
      spoken: "2 more branches: feature/lane-g, origin/feature/lane-h",
      tooltip: "feature/lane-g\norigin/feature/lane-h"
    });
  });

  it("counts chips past the cap into the same pill", async () => {
    layOut(1000, { a: 60, b: 60, c: 60, d: 60 });
    await expect(strip(vm({ refs: ["a", "b", "c", "d"] }))).resolves.toMatchObject({
      chips: ["a", "b"],
      pill: "+2",
      spoken: "2 more branches: c, d"
    });
  });
});
