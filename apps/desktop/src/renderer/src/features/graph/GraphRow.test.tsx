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

describe("GraphRow ref chips", () => {
  const PILL = 20;
  const FLOOR = 40;
  const GLYPH = 20;
  const TAG_FLOOR = 50;

  /** jsdom lays nothing out, so stand in for the meta line's flex layout. The
   *  line has `room` for the tag chip and the strip; the byline, down to its
   *  avatar, follows them at no width, so it shows when they overflow. The tag
   *  chip is rigid at `tag`px, or GLYPH down to its mark. The strip takes the
   *  rest of the line, its children left to right with no gap at their natural
   *  widths, and holds its width once folded to "+N". Squeezed, the last chip
   *  takes what the strip has left and the tag chip what the line has left,
   *  down to FLOOR and TAG_FLOOR — what `.ref-chip.is-squeezed` and
   *  `.commit-tag--tag.is-squeezed` do in app.css. */
  function layOut(room: number, natural: Record<string, number>, tag = 0): void {
    const widthOf = (el: Element, available: number): number => {
      if (el.classList.contains("ref-chip--more")) return PILL;
      const name = el.querySelector(".ref-chip__name")?.textContent ?? "";
      const width = natural[name] ?? 0;
      if (!el.classList.contains("is-squeezed")) return width;
      let others = 0;
      for (const sibling of el.parentElement?.children ?? []) {
        if (sibling !== el) others += widthOf(sibling, available);
      }
      return Math.min(width, Math.max(FLOOR, available - others));
    };
    const boxes = (line: Element) => {
      const tagChip = line.querySelector(".commit-tag--tag");
      const strip = line.querySelector(".ref-chips");
      let held: number | null = null;
      if (strip?.classList.contains("is-folded") === true) {
        held = 0;
        for (const slot of strip.children) held += widthOf(slot, 0);
      }
      let tagWidth = 0;
      if (tagChip !== null) {
        if (tagChip.querySelector(".commit-tag__name.a11y-sr-only") !== null) {
          tagWidth = GLYPH;
        } else if (tagChip.classList.contains("is-squeezed")) {
          tagWidth = Math.min(tag, Math.max(TAG_FLOOR, room - (held ?? 0)));
        } else {
          tagWidth = tag;
        }
      }
      const stripWidth = strip === null ? 0 : (held ?? Math.max(0, room - tagWidth));
      return { tagChip, tagWidth, strip, stripWidth };
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
        const line = this.closest(".commit-meta");
        if (line === null) return rect(0, 0);
        if (this === line) return rect(0, room);
        const { tagChip, tagWidth, strip, stripWidth } = boxes(line);
        if (tagChip?.contains(this) === true) return rect(0, tagWidth);
        if (strip?.contains(this) === true) {
          if (this === strip) return rect(tagWidth, stripWidth);
          let left = tagWidth;
          for (const slot of strip.children) {
            const width = widthOf(slot, stripWidth);
            // A chip's parts (name, PR chip, worktree button) share its box.
            if (slot.contains(this)) return rect(left, width);
            left += width;
          }
        }
        if (this.classList.contains("commit-byline")) {
          return rect(tagWidth + stripWidth, 0);
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

  /** Render a row with a tag chip, hover it, and read what it shows. */
  async function tagged(row: GraphRowVM): Promise<{
    step: "whole" | "squeezed" | "glyph";
    chips: string[];
    pill: string | null;
    spoken: string;
    tooltip: string | null;
  }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<GraphRow {...props(row)} />));
    const tag = container.querySelector<HTMLElement>(".commit-tag--tag")!;
    await act(async () => {
      tag.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const name = tag.querySelector(".commit-tag__name")!;
    const result = {
      step: name.classList.contains("a11y-sr-only")
        ? ("glyph" as const)
        : tag.classList.contains("is-squeezed")
          ? ("squeezed" as const)
          : ("whole" as const),
      chips: [...container.querySelectorAll(".ref-chip__name")].map(
        (n) => n.textContent ?? ""
      ),
      pill: container.querySelector(".ref-chip--more")?.textContent ?? null,
      spoken: tag.textContent ?? "",
      tooltip: document.querySelector('[role="tooltip"]')?.textContent ?? null
    };
    await act(async () => root.unmount());
    container.remove();
    return result;
  }

  const TAG = 70;
  const released = vm({
    ...tipped,
    tag: { name: "v0.21.0", kind: "annotated" }
  });

  it("keeps the tag whole while branch chips fold beside it", async () => {
    // 250 - 70 leaves the strip 180: the first chip (120) and "+1".
    layOut(250, widths, TAG);
    await expect(tagged(released)).resolves.toMatchObject({
      step: "whole",
      chips: ["feature/lane-g"],
      pill: "+1"
    });
    // 100 - 70 leaves 30: not even the first chip's floor, so "+2" alone.
    layOut(100, widths, TAG);
    await expect(tagged(released)).resolves.toMatchObject({
      step: "whole",
      chips: [],
      pill: "+2"
    });
  });

  it("ellipsizes the tag once every branch chip has folded", async () => {
    // Whole, 70 + 20 overflows 80; ellipsized to 60, it fits.
    layOut(80, widths, TAG);
    await expect(tagged(released)).resolves.toMatchObject({
      step: "squeezed",
      chips: [],
      pill: "+2"
    });
  });

  it("drops the name below its floor, and still names the tag", async () => {
    // Even the floor, 50 + 20, overflows 60; the mark, 20 + 20, fits.
    layOut(60, widths, TAG);
    await expect(tagged(released)).resolves.toEqual({
      step: "glyph",
      chips: [],
      pill: "+2",
      spoken: "Annotated tag v0.21.0",
      tooltip: "Annotated tag v0.21.0"
    });
  });

  it.each([
    [100, "whole"],
    [60, "squeezed"],
    [40, "glyph"]
  ] as const)("fits a tag with no branch chips beside it (%ipx: %s)", async (room, step) => {
    layOut(room, {}, TAG);
    await expect(
      tagged(vm({ tag: { name: "v0.20.3", kind: "lightweight" } }))
    ).resolves.toMatchObject({ step, spoken: "Tag v0.20.3" });
  });
});
