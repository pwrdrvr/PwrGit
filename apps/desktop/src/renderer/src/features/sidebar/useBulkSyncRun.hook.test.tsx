// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkSyncSummary, Repo } from "@pwrgit/shared";
import { useBulkSyncRun } from "./useBulkSyncRun";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const repo = (id: string): Repo => ({
  id,
  name: id,
  path: `/repos/${id}`,
  profileId: "personal",
  pinned: false,
  worktrees: []
});
const all = [repo("atlas"), repo("ledger")];
const recent = [all[0]!];

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useBulkSyncRun>;

function Harness() {
  latest = useBulkSyncRun({ profileId: "personal", repos: all, recentRepos: recent });
  return null;
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useBulkSyncRun picks", () => {
  // 0.45.0 ran each pick, so setting the button up started a pull.
  it("sets the face up without starting anything, and the face runs it", () => {
    act(() => latest.pick("pull", "recent"));
    expect(latest.run).toBeNull();
    expect(latest.verb).toBe("pull");
    expect(latest.scope).toBe("recent");
    expect(window.localStorage.getItem("pwrgit.syncVerb")).toBe("pull");

    act(() => latest.runFace());
    expect(latest.run).toMatchObject({
      mode: "soft-pull",
      scope: "recent",
      repoIds: ["atlas"]
    });
  });

  // 0.45.0's timer always fetched, so a face set to Pull never pulled.
  it("runs the face's verb and scope on the timer", () => {
    vi.useFakeTimers();
    try {
      act(() => latest.pick("pull", "recent"));
      act(() => latest.pickInterval(5));
      act(() => vi.advanceTimersByTime(5 * 60_000));
      expect(latest.run).toMatchObject({
        mode: "soft-pull",
        scope: "recent",
        auto: true,
        repoIds: ["atlas"]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes the interval without starting anything", () => {
    act(() => latest.pickInterval(5));
    expect(latest.interval).toBe(5);
    expect(latest.run).toBeNull();
  });
});

describe("useBulkSyncRun Show last run", () => {
  const summary = {
    operationId: "op",
    mode: "soft-pull",
    cancelled: false,
    startedAt: "2026-10-29T12:00:00.000Z",
    finishedAt: "2026-10-29T12:00:05.000Z",
    counts: { repos: { success: 1, partial: 0, skipped: 0, failed: 1, cancelled: 0 } },
    results: []
  } as unknown as BulkSyncSummary;

  it("shows a hidden timed run while it is going", () => {
    act(() => latest.start("fetch", { auto: true }));
    expect(latest.run?.view).toBe("hidden");
    act(() => latest.showRun());
    expect(latest.run).toMatchObject({ view: "dialog", finished: false, auto: true });
  });

  it("keeps the last finished run, and reopens it as a replay after it closed", () => {
    act(() => latest.start("soft-pull", { auto: true }));
    act(() => latest.finish(summary));
    // A timed run nobody opened leaves nothing on screen...
    expect(latest.run).toBeNull();
    // ...but is still there to read.
    expect(latest.lastRun).toMatchObject({ mode: "soft-pull", auto: true, summary });
    act(() => latest.showRun());
    expect(latest.run).toMatchObject({
      view: "dialog",
      finished: true,
      mode: "soft-pull",
      replay: summary
    });
  });
});
