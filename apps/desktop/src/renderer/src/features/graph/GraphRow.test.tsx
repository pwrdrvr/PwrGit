// @vitest-environment jsdom
import type { Commit, MovedTag } from "@pwrgit/shared";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
          cardClosed: () => undefined,
          claimCard: () => undefined
        }}
        now={new Date("2026-08-06T12:01:00.000Z").getTime()}
        selected={false}
        focused={false}
        contextOpen={false}
        flashing={false}
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
    cardClosed: () => undefined,
    claimCard: () => undefined
  },
  now: new Date("2026-08-06T12:01:00.000Z").getTime(),
  selected: false,
  focused: false,
  contextOpen: false,
  flashing: false,
  onOpen: () => undefined,
  onShowContext: () => undefined,
  onHideContext: () => undefined,
  onFocusContext: () => false,
  onOpenContextMenu: () => undefined
});

describe("GraphRow author", () => {
  /** Mount a row whose byline opens a person card, and hand back its parts. */
  async function mountByline(row: GraphRowVM, focusPerson = false) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onShowPerson = vi.fn();
    const onFocusPerson = vi.fn(() => focusPerson);
    const onOpen = vi.fn();
    await act(async () =>
      root.render(
        <GraphRow
          {...props(row)}
          hoverIntent={{
            arm: () => undefined,
            cancel: () => undefined,
            immediate: (open) => open(),
            cardClosed: () => undefined,
            claimCard: () => undefined
          }}
          onOpen={onOpen}
          onShowPerson={onShowPerson}
          onHidePerson={() => undefined}
          onFocusPerson={onFocusPerson}
        />
      )
    );
    const byline = container.querySelector<HTMLButtonElement>("button.commit-byline")!;
    const unmount = async (): Promise<void> => {
      await act(async () => root.unmount());
      container.remove();
    };
    return { byline, onShowPerson, onFocusPerson, onOpen, unmount };
  }

  it("opens the person card on click, without opening the commit", async () => {
    const { byline, onShowPerson, onOpen, unmount } = await mountByline(vm({}));
    expect(byline.textContent).toBe("WCWilhelmina Castellanos");
    await act(async () => byline.click());
    expect(onShowPerson).toHaveBeenCalledWith(byline);
    expect(onOpen).not.toHaveBeenCalled();
    await unmount();
  });

  // The name ellipsizes, and can drop out entirely, when the meta line runs
  // short (app.css `.commit-author`). The button's name never does.
  it("names the whole author for assistive tech, yours included", async () => {
    const other = await mountByline(vm({}));
    expect(other.byline.getAttribute("aria-label")).toBe(
      "Show author Wilhelmina Castellanos"
    );
    await other.unmount();
    const mine = await mountByline(vm({ isMine: true }));
    expect(mine.byline.textContent).toBe("WCyou");
    expect(mine.byline.getAttribute("aria-label")).toBe(
      "Show author (you) Wilhelmina Castellanos"
    );
    await mine.unmount();
  });

  it("hands Tab to an open person card", async () => {
    const { byline, onFocusPerson, unmount } = await mountByline(vm({}), true);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      byline.dispatchEvent(tab);
    });
    expect(onFocusPerson).toHaveBeenCalledOnce();
    expect(tab.defaultPrevented).toBe(true);
    await unmount();
  });

  it("is plain text where no card is wired", () => {
    const markup = renderToStaticMarkup(<GraphRow {...props(vm({}))} />);
    expect(markup).toContain('<span class="commit-byline">');
    expect(markup).not.toContain("<button type=\"button\" class=\"commit-byline");
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

// Moved Tags 3a. Before this, a re-cut tag's chip looked current where it
// stood, and nothing marked the commit the publisher's tag now names.
describe("GraphRow moved tags", () => {
  const moved: MovedTag = {
    name: "v1.4.1",
    local: { objectId: "3".repeat(40), targetId: commit.hash.padEnd(40, "0"), kind: "annotated" as const },
    published: { remote: "origin", objectId: "e".repeat(40), targetId: "0e7e3db".padEnd(40, "0"), kind: "annotated" as const }
  };

  async function rendered(row: GraphRowVM, onTakeTag: (m: MovedTag) => void) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<GraphRow {...props(row)} onTakeTag={onTakeTag} />));
    return {
      container,
      done: async () => {
        await act(async () => root.unmount());
        container.remove();
      }
    };
  }

  it("draws the local tag as moved and takes the published value on click", async () => {
    const take = vi.fn();
    const { container, done } = await rendered(
      vm({ tag: { name: "v1.4.1", kind: "annotated" }, tagMoved: moved }),
      take
    );
    const chip = container.querySelector<HTMLButtonElement>("button.commit-tag--tag.is-moved");
    expect(chip?.getAttribute("aria-label")).toBe(
      "Annotated tag v1.4.1, moved on origin to 0e7e3db. Take origin's…"
    );
    await act(async () => chip?.click());
    expect(take).toHaveBeenCalledWith(moved);
    await done();
  });

  it("draws the publisher's value where it points, dashed, with the same action", async () => {
    const take = vi.fn();
    const { container, done } = await rendered(vm({ publishedTags: [moved] }), take);
    const ghost = container.querySelector<HTMLButtonElement>("button.commit-tag--tag.is-published");
    expect(ghost?.textContent).toBe("originv1.4.1");
    expect(ghost?.getAttribute("aria-label")).toContain("origin's v1.4.1 points here");
    await act(async () => ghost?.click());
    expect(take).toHaveBeenCalledWith(moved);
    await done();
  });

  it("keeps an unmoved tag a plain mark", async () => {
    const { container, done } = await rendered(vm({ tag: { name: "v1.4.0", kind: "annotated" } }), vi.fn());
    expect(container.querySelector("button.commit-tag--tag")).toBeNull();
    expect(container.querySelector("span.commit-tag--tag")).not.toBeNull();
    await done();
  });
});
