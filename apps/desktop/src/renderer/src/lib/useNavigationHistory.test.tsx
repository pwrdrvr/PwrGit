// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_HISTORY_DEPTH,
  pruneNavigation,
  readStoredNavigation,
  recordNavigation,
  stepHistory,
  useNavigationHistory,
  type NavigationHistory,
  type NavigationLocation,
  type NavigationRiders,
  type NavigationStacks
} from "./useNavigationHistory";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const at = (worktreeId: string, repoId = "r1"): NavigationLocation => ({
  repoId,
  worktreeId
});
const ids = (stack: NavigationLocation[]): string[] =>
  stack.map((location) => location.worktreeId);
const leaving = (riders: NavigationRiders = {}) => ({ ...riders, leftAt: 1 });
const EMPTY: NavigationStacks = { back: [], cursor: undefined, forward: [] };

const walk = (...places: string[]): NavigationStacks =>
  places.reduce(
    (stacks, place) => recordNavigation(stacks, at(place), leaving()),
    EMPTY
  );

describe("recordNavigation", () => {
  it("pushes the place left, moves the cursor and clears Forward", () => {
    const stacks = walk("a", "b", "c");
    expect(ids(stacks.back)).toEqual(["a", "b"]);
    expect(stacks.cursor?.worktreeId).toBe("c");

    const stepped = stepHistory(stacks, "back", 1, leaving())!.next;
    expect(ids(stepped.forward)).toEqual(["c"]);
    const branched = recordNavigation(stepped, at("d"), leaving());
    expect(ids(branched.back)).toEqual(["a", "b"]);
    expect(branched.forward).toEqual([]);
  });

  it("records nothing for the place already on screen — a restore's echo", () => {
    const stacks = walk("a", "b");
    expect(recordNavigation(stacks, at("b"), leaving())).toBe(stacks);
  });

  it("puts the riders captured now on the place left, not the ones it was restored with", () => {
    let stacks = recordNavigation(EMPTY, at("a"), leaving());
    stacks = recordNavigation(
      stacks,
      at("b"),
      leaving({ commit: { hash: "abc1234", subject: "Fix" } })
    );
    expect(stacks.back[0]?.commit?.hash).toBe("abc1234");

    // Back to `a` restores its commit; leaving it again with nothing open
    // must not carry the old commit along.
    stacks = stepHistory(stacks, "back", 1, leaving())!.next;
    stacks = recordNavigation(stacks, at("c"), leaving());
    expect(stacks.back.at(-1)?.worktreeId).toBe("a");
    expect(stacks.back.at(-1)?.commit).toBeUndefined();
  });

  it("caps Back at the depth limit", () => {
    const places = Array.from({ length: MAX_HISTORY_DEPTH + 10 }, (_, i) => `w${i}`);
    const stacks = walk(...places);
    expect(stacks.back).toHaveLength(MAX_HISTORY_DEPTH);
    expect(stacks.back[0]?.worktreeId).toBe("w9");
  });
});

describe("stepHistory", () => {
  it("steps back and forward one place at a time", () => {
    const stacks = walk("a", "b", "c");
    const back = stepHistory(stacks, "back", 1, leaving())!;
    expect(back.target.worktreeId).toBe("b");
    expect(ids(back.next.back)).toEqual(["a"]);
    expect(ids(back.next.forward)).toEqual(["c"]);

    const forward = stepHistory(back.next, "forward", 1, leaving())!;
    expect(forward.target.worktreeId).toBe("c");
    expect(ids(forward.next.back)).toEqual(["a", "b"]);
    expect(forward.next.forward).toEqual([]);
  });

  it("jumps several steps and keeps the rest of the stack, as a browser's menu does", () => {
    const stacks = walk("a", "b", "c", "d");
    const jump = stepHistory(stacks, "back", 3, leaving())!;
    expect(jump.target.worktreeId).toBe("a");
    expect(jump.next.back).toEqual([]);
    expect(ids(jump.next.forward)).toEqual(["b", "c", "d"]);

    const ahead = stepHistory(jump.next, "forward", 2, leaving())!;
    expect(ahead.target.worktreeId).toBe("c");
    expect(ids(ahead.next.back)).toEqual(["a", "b"]);
    expect(ids(ahead.next.forward)).toEqual(["d"]);
  });

  it("answers undefined past either end", () => {
    const stacks = walk("a", "b");
    expect(stepHistory(stacks, "back", 2, leaving())).toBeUndefined();
    expect(stepHistory(stacks, "forward", 1, leaving())).toBeUndefined();
  });
});

describe("pruneNavigation", () => {
  it("drops removed worktrees and collapses the neighbours they leave", () => {
    const stacks = walk("a", "gone", "a", "b");
    const pruned = pruneNavigation(stacks, new Set(["a", "b"]));
    expect(ids(pruned.back)).toEqual(["a"]);
    expect(pruned.cursor?.worktreeId).toBe("b");
  });

  it("returns the same stacks when everything is still there", () => {
    const stacks = walk("a", "b");
    expect(pruneNavigation(stacks, new Set(["a", "b"]))).toBe(stacks);
  });
});

describe("readStoredNavigation", () => {
  afterEach(() => window.localStorage.clear());

  it("reads a saved history and skips malformed entries", () => {
    window.localStorage.setItem(
      "pwrgit.navigationHistory.p1",
      JSON.stringify({
        back: [at("a"), { worktreeId: 7 }, "junk"],
        cursor: at("b"),
        forward: null
      })
    );
    const stacks = readStoredNavigation("p1");
    expect(ids(stacks.back)).toEqual(["a"]);
    expect(stacks.cursor?.worktreeId).toBe("b");
    expect(stacks.forward).toEqual([]);
  });

  it("starts empty on unparseable storage", () => {
    window.localStorage.setItem("pwrgit.navigationHistory.p1", "{");
    expect(readStoredNavigation("p1")).toEqual(EMPTY);
  });
});

describe("useNavigationHistory", () => {
  afterEach(() => window.localStorage.clear());

  async function mount() {
    let history: NavigationHistory | null = null;
    let setCurrent: (worktreeId: string) => void = () => undefined;
    const restored: NavigationLocation[] = [];
    const { useState } = await import("react");
    function Probe() {
      const [current, set] = useState({ repoId: "r1", worktreeId: "a" });
      setCurrent = (worktreeId) => set({ repoId: "r1", worktreeId });
      history = useNavigationHistory({
        profileId: "p1",
        current,
        restore: (location) => {
          restored.push(location);
          set({ repoId: location.repoId, worktreeId: location.worktreeId });
        },
        capture: () => ({ anchor: { key: "wt:x", offset: 40 } }),
        liveWorktreeIds: undefined
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    return {
      history: () => history!,
      go: (worktreeId: string) => act(async () => setCurrent(worktreeId)),
      restored,
      unmount: () => act(async () => root.unmount())
    };
  }

  it("records each selection, and Back restores the last one without recording it again", async () => {
    const probe = await mount();
    await probe.go("b");
    await probe.go("c");
    expect(ids(probe.history().stacks.back)).toEqual(["a", "b"]);
    expect(probe.history().stacks.back[1]?.anchor).toEqual({
      key: "wt:x",
      offset: 40
    });

    await act(async () => probe.history().goBack());
    expect(probe.restored.at(-1)?.worktreeId).toBe("b");
    expect(ids(probe.history().stacks.back)).toEqual(["a"]);
    expect(ids(probe.history().stacks.forward)).toEqual(["c"]);
    expect(probe.history().canGoForward).toBe(true);

    // Saved beside the selection, so it survives a relaunch.
    expect(ids(readStoredNavigation("p1").back)).toEqual(["a"]);
    await probe.unmount();
  });
});
