// @vitest-environment jsdom
import type { Commit } from "@pwrgit/shared";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

describe("GraphRow author", () => {
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
  const props = (row: GraphRowVM): ComponentProps<typeof GraphRow> => ({
    vm: row,
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
});
