// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoPaging } from "./useAutoPaging";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/** Reports the observed node as visible the moment it is watched — the case
 *  the hook exists for, and the one that made a failing page loop. */
class ImmediateObserver {
  constructor(private readonly cb: (entries: unknown[]) => void) {}
  observe(): void {
    this.cb([{ isIntersecting: true }]);
  }
  disconnect(): void {}
  unobserve(): void {}
}

let container: HTMLDivElement;
let root: Root;

function Harness({
  cursors,
  onLoad
}: {
  /** Cursor to hand the hook after each settled load; null ends paging. */
  cursors: (string | null)[];
  onLoad: (cursor: string) => "ok" | "fail";
}) {
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextCursor = cursors[page] ?? null;
  const ref = useAutoPaging(nextCursor, loading, error, (cursor) => {
    setLoading(true);
    queueMicrotask(() => {
      act(() => {
        const outcome = onLoad(cursor);
        setLoading(false);
        if (outcome === "fail") setError("boom");
        else setPage((current) => current + 1);
      });
    });
  });
  return createElement("button", { ref }, "Load more");
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", ImmediateObserver);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

describe("useAutoPaging", () => {
  it("fills a viewport, then stops when there is nothing left", async () => {
    const seen: string[] = [];
    await act(async () => {
      root.render(
        createElement(Harness, {
          cursors: ["c1", "c2", null],
          onLoad: (cursor) => {
            seen.push(cursor);
            return "ok";
          }
        })
      );
    });
    await settle();
    expect(seen).toEqual(["c1", "c2"]);
  });

  it("does not re-request a page that failed", async () => {
    const seen: string[] = [];
    await act(async () => {
      root.render(
        createElement(Harness, {
          cursors: ["c1", "c2", null],
          onLoad: (cursor) => {
            seen.push(cursor);
            return "fail";
          }
        })
      );
    });
    await settle();
    // Before the error guard this ran until the process gave up: `loading`
    // cleared, the effect re-observed, and the same cursor went out again.
    expect(seen).toEqual(["c1"]);
  });

  it("asks for any one cursor at most once", async () => {
    const seen: string[] = [];
    await act(async () => {
      root.render(
        createElement(Harness, {
          // A caller that never advances would otherwise spin forever.
          cursors: ["c1", "c1", "c1", null],
          onLoad: (cursor) => {
            seen.push(cursor);
            return "ok";
          }
        })
      );
    });
    await settle();
    expect(seen).toEqual(["c1"]);
  });

  it("does nothing where IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const seen: string[] = [];
    await act(async () => {
      root.render(
        createElement(Harness, {
          cursors: ["c1", null],
          onLoad: (cursor) => {
            seen.push(cursor);
            return "ok";
          }
        })
      );
    });
    await settle();
    expect(seen).toEqual([]);
  });
});
