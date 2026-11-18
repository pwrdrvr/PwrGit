// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdFocus } from "./holdFocus";

let frames: FrameRequestCallback[] = [];
const runFrame = (): void => {
  const due = frames;
  frames = [];
  due.forEach((cb) => cb(0));
};

beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
});
afterEach(() => vi.restoreAllMocks());

const el = (id: string): HTMLElement => document.getElementById(id)!;

describe("holdFocus", () => {
  it("puts focus back when a later move drops it to <body>", () => {
    el("a").focus();
    holdFocus(el("a"));
    runFrame();
    expect(document.activeElement).toBe(el("a"));
    // A re-render a few frames later moves the node: focus falls to <body>.
    el("a").blur();
    expect(document.activeElement).toBe(document.body);
    runFrame();
    expect(document.activeElement).toBe(el("a"));
  });

  it("never takes focus from where the reader went next", () => {
    el("a").focus();
    holdFocus(el("a"));
    el("b").focus();
    runFrame();
    expect(document.activeElement).toBe(el("b"));
    expect(frames).toHaveLength(0);
  });
});
