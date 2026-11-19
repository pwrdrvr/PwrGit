// @vitest-environment jsdom
import fc from "fast-check";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GraphRow } from "./GraphRow";
import type { LaneRow } from "./lane-layout";

const noop = () => undefined;
const time = "2026-08-06T12:00:00.000Z";

function props(row: LaneRow): ComponentProps<typeof GraphRow> {
  return {
    vm: {
      commit: {
        hash: "abcdef0123456789",
        shortHash: "abcdef0",
        parents: ["parent"],
        subject: "Record the route checksum",
        authorName: "Ada Reed",
        authorEmail: "ada@example.invalid",
        committedAt: time,
        isMerge: false
      },
      row,
      refs: [],
      remoteRefs: [],
      isHead: false,
      isHeadOnly: false,
      isMine: false,
      defaultBranch: "main"
    },
    laneCount: 24,
    now: new Date(time).getTime(),
    selected: false,
    focused: false,
    contextOpen: false,
    flashing: false,
    hoverIntent: { arm: noop, cancel: noop, immediate: noop, cardClosed: noop, claimCard: noop },
    onOpen: noop,
    onShowContext: noop,
    onHideContext: noop,
    onFocusContext: () => false,
    onOpenContextMenu: noop
  };
}

describe("GraphRow lane geometry", () => {
  it("reuses the segments on row interaction and compares cloned segments once on refresh", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const from = vi.fn(() => 12);
    const segment = {
      get from() { return from(); },
      to: 12,
      dashed: 1
    };
    const original = props({
      lane: 0,
      top: [segment],
      bottom: [{ from: 12, to: 12, dashed: 1 }]
    });
    try {
      await act(async () => root.render(<GraphRow {...original} />));
      from.mockClear();
      await act(async () => root.render(<GraphRow {...original} selected />));
      expect(from).not.toHaveBeenCalled();

      const clonedFrom = vi.fn(() => 12);
      const row = {
        lane: 0,
        top: [{ get from() { return clonedFrom(); }, to: 12, dashed: 1 }],
        bottom: [{ from: 12, to: 12, dashed: 1 }]
      };
      await act(async () => root.render(
        <GraphRow {...original} vm={{ ...original.vm, row }} selected />
      ));
      expect(clonedFrom).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("draws the same SVG after an edit as a fresh render of the edited geometry", async () => {
    const lane = fc.integer({ min: 0, max: 22 });
    const segment = fc.record({
      from: lane, to: lane, dashed: fc.integer({ min: 1, max: 3 })
    }, { requiredKeys: ["from", "to"] });
    const edges = fc.array(segment, { minLength: 2, maxLength: 4 });
    const landings = fc.array(fc.record({
      from: lane, to: lane, number: fc.integer({ min: 1, max: 100 })
    }), { minLength: 2, maxLength: 4 });
    const edits = [
      "topFrom", "topDash", "topOrder", "bottomTo", "bottomDash", "bottomLength",
      "landingTopNumber", "landingTopTo", "landingBottomNumber", "landingBottomOrder"
    ] as const;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await fc.assert(fc.asyncProperty(edges, edges, landings, landings, fc.constantFrom(...edits),
        async (top, bottom, landingTop, landingBottom, edit) => {
          const initial = {
            ...props({ lane: 0, top, bottom }),
            prLanding: { top: landingTop, bottom: landingBottom }
          };
          await act(async () => root.render(<GraphRow {...initial} />));

          const next = {
            ...initial,
            vm: { ...initial.vm, row: {
              lane: 0,
              top: top.map((s) => ({ ...s })),
              bottom: bottom.map((s) => ({ ...s }))
            } },
            prLanding: {
              top: landingTop.map((s) => ({ ...s })),
              bottom: landingBottom.map((s) => ({ ...s }))
            }
          };
          switch (edit) {
            case "topFrom": next.vm.row.top[0]!.from += 1; break;
            case "topDash": next.vm.row.top[0]!.dashed = 4; break;
            case "topOrder": next.vm.row.top.reverse(); break;
            case "bottomTo": next.vm.row.bottom[0]!.to += 1; break;
            case "bottomDash": next.vm.row.bottom[0]!.dashed = 4; break;
            case "bottomLength": next.vm.row.bottom.pop(); break;
            case "landingTopNumber": next.prLanding.top[0]!.number += 1; break;
            case "landingTopTo": next.prLanding.top[0]!.to += 0.5; break;
            case "landingBottomNumber": next.prLanding.bottom[0]!.number += 1; break;
            case "landingBottomOrder": next.prLanding.bottom.reverse(); break;
          }
          await act(async () => root.render(<GraphRow {...next} />));
          const fresh = document.createElement("template");
          fresh.innerHTML = renderToStaticMarkup(<GraphRow {...next} />);
          expect(container.querySelector("svg.graph-lanes")?.isEqualNode(
            fresh.content.querySelector("svg.graph-lanes")
          )).toBe(true);
        }
      ));
    } finally {
      await act(async () => root.unmount());
    }
  });
});
