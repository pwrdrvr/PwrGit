import { describe, expect, it } from "vitest";
import {
  STRIP_GAP,
  STRIP_LABEL_BAND,
  STRIP_MAX_HEIGHT,
  STRIP_PAD,
  stripLayout
} from "./image-clipboard";

describe("stripLayout", () => {
  it("puts equal panels side by side with one gap between them", () => {
    const { width, height, boxes } = stripLayout([
      { w: 200, h: 100 },
      { w: 200, h: 100 }
    ]);

    expect(boxes).toEqual([
      { x: STRIP_PAD, y: STRIP_PAD + STRIP_LABEL_BAND, w: 200, h: 100 },
      {
        x: STRIP_PAD + 200 + STRIP_GAP,
        y: STRIP_PAD + STRIP_LABEL_BAND,
        w: 200,
        h: 100
      }
    ]);
    // Padding on both ends, and the gap only BETWEEN the two.
    expect(width).toBe(STRIP_PAD * 2 + 200 * 2 + STRIP_GAP);
    expect(height).toBe(STRIP_PAD * 2 + STRIP_LABEL_BAND + 100);
  });

  it("matches on the shortest panel rather than upscaling the others", () => {
    // A 2x export beside its 1x twin: the pair reads as one picture only if
    // both are drawn at one height, and the smaller must not be interpolated
    // up to meet the larger.
    const { boxes, height } = stripLayout([
      { w: 400, h: 200 },
      { w: 200, h: 100 }
    ]);

    expect(height).toBe(STRIP_PAD * 2 + STRIP_LABEL_BAND + 100);
    expect(boxes.map((box) => box.h)).toEqual([100, 100]);
    // Aspect ratios survive the match.
    expect(boxes.map((box) => box.w)).toEqual([200, 200]);
  });

  it("caps a strip of retina screenshots", () => {
    const { boxes } = stripLayout([
      { w: 6000, h: 4000 },
      { w: 6000, h: 4000 }
    ]);

    expect(boxes[0]?.h).toBe(STRIP_MAX_HEIGHT);
    expect(boxes[0]?.w).toBe(Math.round(6000 * (STRIP_MAX_HEIGHT / 4000)));
  });

  it("ignores panels that never decoded", () => {
    const { boxes, width } = stripLayout([
      { w: 0, h: 0 },
      { w: 200, h: 100 }
    ]);

    expect(boxes).toHaveLength(1);
    expect(width).toBe(STRIP_PAD * 2 + 200);
  });

  it("has nothing to draw when no panel decoded", () => {
    expect(stripLayout([{ w: 0, h: 0 }])).toEqual({
      width: 0,
      height: 0,
      boxes: []
    });
  });
});
