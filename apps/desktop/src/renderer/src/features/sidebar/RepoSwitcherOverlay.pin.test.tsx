// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type RepoSearchHit } from "@pwrgit/shared";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), copyText: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({
  // The footer's scope toggle reads the setting on mount; these suites are
  // about rows, so answer it here instead of in every dispatch mock.
  dispatch: (command: string, req: unknown) =>
    command === "settings:read"
      ? Promise.resolve({ ok: true, value: { general: { searchAllProfiles: false } } })
      : mocks.dispatch(command, req),
  subscribe: () => () => {},
  windowProfileId: () => "default"
}));
vi.mock("../../lib/copyText", () => ({ copyText: mocks.copyText }));
import { RepoSwitcherOverlay } from "./RepoSwitcherOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const onPick = vi.fn();
const onClose = vi.fn();
const hit: RepoSearchHit = {
  kind: "repo", repoId: "demo", name: "demo", path: "/repos/demo",
  profileId: "default", profileName: "Personal", worktreeCount: 1, pinned: false
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.copyText.mockResolvedValue(undefined);
  vi.stubGlobal("IntersectionObserver", class {
    observe() {} disconnect() {}
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(hits: RepoSearchHit[], platform = "darwin") {
  mocks.dispatch.mockResolvedValue(ok(hits));
  await act(async () => root.render(<RepoSwitcherOverlay
    commits={[]} commitContext={null} onClose={onClose} onPick={onPick}
    onPickCommit={vi.fn()} onPickFile={vi.fn()} platform={platform} profileCount={1}
  />));
}
async function key(key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  await act(async () => container.querySelector("input")!.dispatchEvent(event));
  return event;
}
const pinButtons = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button.pin")];

it("pins a local branch through branch:setPin, and never offers a pin on a remote one", async () => {
  await render([
    { ...hit, kind: "local_branch", name: "main", repoId: "codex" },
    { ...hit, kind: "remote_branch", name: "feature/x", repoId: "codex", remoteRef: "origin/feature/x" }
  ]);
  const buttons = pinButtons();
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.getAttribute("aria-label")).toBe("Pin branch");
  mocks.dispatch.mockClear();
  await act(async () => buttons[0]!.click());
  expect(mocks.dispatch).toHaveBeenCalledWith("branch:setPin", {
    repoId: "codex",
    branch: "main",
    pinned: true
  });
  expect(pinButtons()[0]!.getAttribute("aria-label")).toBe("Unpin branch");
});

it("pins the selected local branch with the ⌘P shortcut and says so in the footer", async () => {
  await render([{ ...hit, kind: "local_branch", name: "main", repoId: "codex" }]);
  expect(container.querySelector(".overlay-foot")?.textContent).toContain("pin");
  mocks.dispatch.mockClear();
  await key("p", { metaKey: true });
  expect(mocks.dispatch).toHaveBeenCalledWith("branch:setPin", {
    repoId: "codex",
    branch: "main",
    pinned: true
  });
});

