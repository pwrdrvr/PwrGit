import { describe, expect, it } from "vitest";
import { placeViewportTooltip } from "./useViewportTooltip";

const viewport = { width: 1440, height: 900 };
const graph = { left: 320, right: 1096, top: 120, bottom: 184 };
const card = { width: 336, height: 430 };

describe("placeViewportTooltip", () => {
  it("spills a pointer near the graph's left edge into the sidebar", () => {
    expect(
      placeViewportTooltip({
        viewport,
        target: graph,
        tooltip: card,
        anchor: { x: 350, y: 250 }
      })
    ).toEqual({ left: 12, top: 258 });
  });

  it("spills a pointer near the graph's right edge into the rail", () => {
    expect(
      placeViewportTooltip({
        viewport,
        target: graph,
        tooltip: card,
        anchor: { x: 1060, y: 250 }
      })
    ).toEqual({ left: 1092, top: 258 });
  });

  it("keeps a central pointer beside the cursor and flips above near the bottom", () => {
    expect(
      placeViewportTooltip({
        viewport,
        target: graph,
        tooltip: card,
        anchor: { x: 700, y: 820 }
      })
    ).toEqual({ left: 708, top: 382 });
  });
});
