// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@pwrgit/shared";
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
