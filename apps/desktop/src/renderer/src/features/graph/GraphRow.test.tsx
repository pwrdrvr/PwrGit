import type { Commit } from "@pwrgit/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GraphRow } from "./GraphRow";

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
