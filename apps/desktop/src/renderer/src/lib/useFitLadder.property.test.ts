// @vitest-environment jsdom

import fc from "fast-check";
import { act, createElement, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushFitLadders, useStepLadder } from "./useFitLadder";

class TestResizeObserver {
  static active = new Set<TestResizeObserver>();
  private targets = new Set<Element>();

  constructor(private callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.targets.add(target);
    TestResizeObserver.active.add(this);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
    if (this.targets.size === 0) this.disconnect();
  }

  disconnect(): void {
    this.targets.clear();
    TestResizeObserver.active.delete(this);
  }

  static deliver(target?: Element): void {
    for (const observer of this.active) {
      const entries = [...observer.targets]
        .filter((element) => target === undefined || target === element)
        .map((target) => ({ target }) as ResizeObserverEntry);
      if (entries.length > 0) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  }
}

const STEPS = ["reduce", "compact", "minimal"];
const fonts = new EventTarget();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
});

function depths(): number[] {
  return [...host.children].map((row) =>
    STEPS.filter((step) => row.classList.contains(step)).length
  );
}

function Row({
  fits,
  onRead,
  steps = STEPS,
  captureRefit,
  watch
}: {
  fits: (depth: number) => boolean;
  onRead?: () => void;
  steps?: string[];
  captureRefit?: (refit: () => void) => void;
  watch?: Element;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const refit = useStepLadder(ref, () => {
    onRead?.();
    return fits(STEPS.filter((step) => ref.current!.classList.contains(step)).length);
  }, steps, { observe: () => watch ?? ref.current });
  useLayoutEffect(() => captureRefit?.(refit), [captureRefit, refit]);
  return createElement("div", { ref, className: "row" });
}

it("finds each first fit with one read phase per depth, even when fit is nonmonotonic", async () => {
  const masks = fc.array(fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()), {
    minLength: 2,
    maxLength: 6
  });
  await fc.assert(fc.asyncProperty(masks, async (rows) => {
    const reads: number[][] = [];
    const answers = rows.map((row) => {
      const first = row.indexOf(true);
      return first < 0 ? STEPS.length : first;
    });
    const expectedReads = STEPS.flatMap((_, step) => {
      const snapshot = answers.map((answer) => Math.min(answer, step));
      return answers.filter((answer) => answer >= step).map(() => snapshot);
    });

    // Begin at maximum degradation so this also exercises restoring detail.
    await act(() => root.render(rows.map((_, key) =>
      createElement(Row, { key, fits: () => false })
    )));
    await act(() => root.render(rows.map((row, key) =>
      createElement(Row, { key, fits: (depth) => row[depth]!, onRead: () => reads.push(depths()) })
    )));
    expect(depths()).toEqual(answers);
    expect(reads).toEqual(expectedReads);

    reads.length = 0;
    await act(() => TestResizeObserver.deliver());
    expect(depths()).toEqual(answers);
    expect(reads).toEqual(expectedReads);
  }), { numRuns: 30 });
});

it("uses the most recently committed predicate for both resize and font notifications", async () => {
  let room = 0;
  const render = (need: number) =>
    act(() => root.render(createElement(Row, { fits: (depth) => room + depth >= need })));

  await render(1);
  await render(3);
  expect(depths()).toEqual([3]);

  room = 1;
  await act(() => TestResizeObserver.deliver());
  expect(depths()).toEqual([2]);

  room = 2;
  await act(() => { fonts.dispatchEvent(new Event("loadingdone")); });
  expect(depths()).toEqual([1]);
});

it("coalesces child requests and ignores a queued request after unmount", async () => {
  const fits = vi.fn(() => true);
  let refit: () => void = () => { throw new Error("refit was not captured"); };
  await act(() => root.render(createElement(Row, {
    fits,
    captureRefit: (request) => { refit = request; }
  })));
  fits.mockClear();
  await act(() => {
    refit();
    refit();
  });
  expect(fits).toHaveBeenCalledTimes(1);

  fits.mockClear();
  await act(() => {
    refit();
    root.unmount();
  });
  expect(fits).not.toHaveBeenCalled();
  expect(TestResizeObserver.active.size).toBe(0);
});

it("lets a parent read final child geometry in the same commit", async () => {
  const fits = vi.fn((depth: number) => depth === 2);
  let measured: number[] = [];
  function Parent() {
    useLayoutEffect(() => {
      flushFitLadders();
      measured = depths();
    });
    return createElement(Row, { fits });
  }
  await act(() => root.render(createElement(Parent)));
  expect(measured).toEqual([2]);
  expect(fits).toHaveBeenCalledTimes(3);
});

it("reroutes a changed observation while another ladder still watches the original target", async () => {
  const first = document.createElement("div");
  const second = document.createElement("div");
  const moved = vi.fn(() => true);
  const stayed = vi.fn(() => true);
  const render = (watch: Element) => act(() => root.render([
    createElement(Row, { key: "moved", fits: moved, watch }),
    createElement(Row, { key: "stayed", fits: stayed, watch: first })
  ]));
  await render(first);
  await render(second);
  moved.mockClear();
  stayed.mockClear();

  await act(() => TestResizeObserver.deliver(first));
  expect(moved).not.toHaveBeenCalled();
  expect(stayed).toHaveBeenCalledTimes(1);

  await act(() => TestResizeObserver.deliver(second));
  expect(moved).toHaveBeenCalledTimes(1);
  expect(stayed).toHaveBeenCalledTimes(1);
});

it("retires old step classes and observers when a mounted ladder becomes empty", async () => {
  await act(() => root.render(createElement(Row, { fits: () => false })));
  expect(depths()).toEqual([3]);
  await act(() => root.render(createElement(Row, { fits: () => false, steps: [] })));
  expect(depths()).toEqual([0]);
  expect(TestResizeObserver.active.size).toBe(0);
});
