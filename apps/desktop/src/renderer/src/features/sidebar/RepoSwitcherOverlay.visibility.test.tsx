// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type RepoSearchHit } from "@pwrgit/shared";
import { RepoSwitcherOverlay } from "./RepoSwitcherOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  // The footer's scope toggle reads the setting on mount; these suites are
  // about rows, so answer it here instead of in every dispatch mock.
  dispatch: (command: string, req: unknown) =>
    command === "settings:read"
      ? Promise.resolve({ ok: true, value: { general: { searchAllProfiles: false } } })
      : dispatch(command, req),
  subscribe: () => () => {},
  windowProfileId: () => "default"
}));

const branch = (name: string): RepoSearchHit => ({
  kind: "local_branch", repoId: "repo", repoName: "Demo", name,
  path: "/repo", profileId: "profile", profileName: "Test",
  pinned: false, worktreeCount: 0
});
const first = branch("fix/first");
const second = branch("fix/second");
const worktree: RepoSearchHit = {
  ...first, kind: "worktree", worktreeId: "linked", path: "/linked"
};
let root: Root;
let container: HTMLDivElement;
let callback: IntersectionObserverCallback;
let onPick: ReturnType<typeof vi.fn<(hit: RepoSearchHit) => void>>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: IntersectionObserverCallback) { callback = cb; }
    observe() {}
    disconnect() {}
  });
  dispatch.mockReset();
  dispatch.mockImplementation(async (command: string) => {
    if (command === "repo:search") return ok([first, second]);
    if (command === "search:branchWorktree") return ok(worktree);
    return ok({ lastActivityAt: null, dirty: null, ahead: null, behind: null });
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onPick = vi.fn<(hit: RepoSearchHit) => void>();
  await act(async () => {
    root.render(<RepoSwitcherOverlay platform="darwin" commits={[]} commitContext={null}
      onClose={() => {}} onPick={onPick} onPickCommit={() => {}}
      onPickFile={() => {}} profileCount={1} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const visibility = async (visible: boolean) => {
  const target = container.querySelector("[data-hit-key]")!;
  await act(async () => callback([
    { target, isIntersecting: visible } as IntersectionObserverEntry
  ], {} as IntersectionObserver));
};
const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const branchCalls = () => dispatch.mock.calls.filter(
  ([command]) => command === "search:branchWorktree"
);

it("checks only visible branches after debounce and opens the resolved checkout", async () => {
  await advance(1_000);
  expect(branchCalls()).toHaveLength(0);
  await visibility(true);
  await advance(199);
  expect(branchCalls()).toHaveLength(0);
  await advance(1);
  expect(branchCalls()).toEqual([
    ["search:branchWorktree", { repoId: "repo", branch: "fix/first" }]
  ]);
  expect(container.querySelectorAll('[data-hit-key^="worktree:"]')).toHaveLength(1);
  await act(async () => {
    container.querySelector<HTMLElement>('[data-hit-key^="worktree:"]')!.click();
  });
  expect(onPick).toHaveBeenCalledExactlyOnceWith(worktree);
});

it("cancels a branch that scrolls away before the debounce completes", async () => {
  await visibility(true);
  await advance(100);
  await visibility(false);
  await advance(500);
  expect(branchCalls()).toHaveLength(0);
});

it("resolves an immediate click before offering to create a checkout", async () => {
  await act(async () => {
    container.querySelector<HTMLElement>("[data-hit-key]")!.click();
  });
  expect(branchCalls()).toHaveLength(1);
  expect(onPick).toHaveBeenCalledExactlyOnceWith(worktree);
});

it("memoizes a verified unused branch when it scrolls back into view", async () => {
  dispatch.mockImplementation(async (command: string) => {
    if (command === "search:branchWorktree") return ok(null);
    return ok([first, second]);
  });
  await visibility(true);
  await advance(200);
  await visibility(false);
  await visibility(true);
  await advance(500);
  expect(branchCalls()).toHaveLength(1);
  expect(container.querySelectorAll('[data-hit-key^="local_branch:"]')).toHaveLength(2);
});
