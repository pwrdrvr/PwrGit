// @vitest-environment jsdom

import fc from "fast-check";
import { act, createElement, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushFitLadders, useFitLadder, useStepLadder } from "./useFitLadder";

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

it("fits the current refs when any one of the stepped row, box or end is replaced", async () => {
  const makeElement = (right: () => number) => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => new DOMRect(0, 0, right(), 0);
    return element;
  };
  const depth = (row: Element) => STEPS.filter((step) => row.classList.contains(step)).length;

  function SimpleRow({ row, box, end }: { row: HTMLElement; box: HTMLElement; end: HTMLElement }) {
    const rowRef = useRef<HTMLElement>(null);
    const boxRef = useRef<HTMLElement>(null);
    const endRef = useRef<HTMLElement>(null);
    // Simulate React publishing new ref targets before the fit's layout effect,
    // with no mutations to the previously observed subtree.
    useLayoutEffect(() => {
      rowRef.current = row;
      boxRef.current = box;
      endRef.current = end;
    });
    useFitLadder(rowRef, boxRef, endRef, STEPS);
    return null;
  }

  await fc.assert(fc.asyncProperty(
    fc.array(fc.tuple(fc.constantFrom("row", "box", "end"), fc.integer({ min: 0, max: 3 })), { minLength: 3 }),
    async (replacements) => {
      let rowInset = 0;
      let boxRight = 100;
      let endRight = 110;
      const currentEnd = (): number => endRight + rowInset - depth(sequence.row) * 10;
      const sequence = {
        row: makeElement(() => 0),
        box: makeElement(() => boxRight),
        end: makeElement(currentEnd)
      };
      await act(() => root.render(createElement(SimpleRow, { ...sequence })));
      expect(depth(sequence.row)).toBe(1);
      for (const [ref, size] of replacements) {
        const previous = sequence.row;
        if (ref === "row") {
          rowInset = size * 10;
          sequence.row = makeElement(() => 0);
        } else if (ref === "box") {
          boxRight = 90 + size * 10;
          sequence.box = makeElement(() => boxRight);
        } else {
          endRight = 90 + size * 10;
          sequence.end = makeElement(currentEnd);
        }
        await act(() => root.render(createElement(SimpleRow, { ...sequence })));
        // Each step gains 10px, capped at the last presentation.
        const needed = (endRight + rowInset - boxRight) / 10;
        expect(depth(sequence.row)).toBe(Math.min(STEPS.length, Math.max(0, needed)));
        if (ref === "row") expect(depth(previous)).toBe(0);
      }
    }
  ), { numRuns: 20 });
});

it("fits in-flow changes while ignoring overlay and same-column updates, even in mixed batches", async () => {
  function Toolbar() {
    const row = useRef<HTMLDivElement>(null);
    const end = useRef<HTMLSpanElement>(null);
    useFitLadder(row, row, end, STEPS);
    return createElement("div", { ref: row },
      createElement("span", { "data-fit-text-columns": 1 }, "1"),
      createElement("span", { ref: end }));
  }

  const operations = fc.array(fc.tuple(
    fc.constantFrom("overlay", "same-columns", "columns", "in-flow", "mixed"),
    fc.integer({ min: 1, max: 3 })
  ), { minLength: 4, maxLength: 16 });
  let key = 0;
  await fc.assert(fc.asyncProperty(operations, async (sequence) => {
    await act(() => root.render(createElement(Toolbar, { key: key++ })));
    const row = host.firstElementChild!;
    const count = row.firstElementChild!;
    const end = row.lastElementChild!;
    const overlay = document.createElement("span");
    overlay.setAttribute("data-fit-overlay", "");
    const segment = overlay.appendChild(document.createElement("i"));
    let columns = 1;
    let offset = 0;
    let reads = 0;
    row.getBoundingClientRect = () => new DOMRect(0, 0, 100, 0);
    end.getBoundingClientRect = () => {
      reads++;
      return new DOMRect(0, 0, 100 + 10 * (columns + offset - depths()[0]!), 0);
    };
    await act(() => TestResizeObserver.deliver(row));
    for (const [operation, value] of sequence) {
      reads = 0;
      const changesFit = operation === "columns" || operation === "in-flow" || operation === "mixed";
      await act(() => {
        if (operation === "overlay" || operation === "mixed") {
          if (overlay.parentElement === null) row.insertBefore(overlay, end);
          else if (segment.dataset["value"] === String(value)) overlay.remove();
          segment.setAttribute("style", `flex-grow: ${value}`);
          segment.dataset["value"] = String(value);
        }
        if (operation === "same-columns") {
          count.firstChild!.nodeValue = String(value).repeat(columns);
        }
        if (operation === "columns") {
          columns = columns % 3 + 1;
          count.setAttribute("data-fit-text-columns", String(columns));
          count.firstChild!.nodeValue = String(value).repeat(columns);
        }
        if (operation === "in-flow" || operation === "mixed") {
          offset = (offset + value) % 3;
          end.setAttribute("width", String(offset));
        }
      });
      if (changesFit) {
        expect(reads).toBeGreaterThan(0);
      } else {
        expect(reads).toBe(0);
      }
      expect(depths()).toEqual([Math.min(STEPS.length, columns + offset)]);
    }
    await act(() => root.render(null));
  }), { numRuns: 20 });
});
