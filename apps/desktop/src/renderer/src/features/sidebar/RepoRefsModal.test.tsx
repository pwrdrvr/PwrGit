// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type RepoRefs, type Repo } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { RepoRefsModal } from "./RepoRefsModal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const repo: Repo = {
  id: "repo-1",
  name: "widget",
  path: "/repos/widget",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};
const refs: RepoRefs = { branches: [], previewTags: [], tagCount: 0, remotes: [] };

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;

beforeEach(() => {
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
    if (channel === "pr:openList") {
      return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [] }));
    }
    return Promise.resolve(ok({ rows: [], total: 0 }));
  });
  // The sidebar control that opened the browser, behind the backdrop.
  opener = document.createElement("button");
  opener.textContent = "Branches";
  document.body.append(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
  vi.resetAllMocks();
});

async function open(): Promise<void> {
  await act(async () => {
    root.render(
      <RepoRefsModal
        repo={repo}
        refs={refs}
        focusedWorktree={null}
        now={0}
        initialTab="branches"
        onRefresh={() => undefined}
        onRevealWorktree={() => undefined}
        onCreateWorktree={() => undefined}
        onClose={() => undefined}
      />
    );
  });
}

function press(target: Element, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
    );
  });
}

const dialog = (): HTMLElement =>
  container.querySelector<HTMLElement>('[role="dialog"]')!;
const controls = (): HTMLElement[] =>
  [...dialog().querySelectorAll<HTMLElement>("button, input")].filter(
    (el) => !(el as HTMLButtonElement).disabled
  );
const close = (): HTMLElement => dialog().querySelector<HTMLElement>('[aria-label="Close"]')!;

// The browser said role="dialog" but trapped nothing: Tab walked off its last
// control into the sidebar behind the backdrop (SC 2.4.3).
describe("RepoRefsModal as a modal", () => {
  it("says it is modal, and still lands focus in the search field", async () => {
    await open();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog().querySelector(".refs-search input"));
  });

  it("wraps Tab from its last control to Close, and back", async () => {
    await open();
    expect(controls()[0]).toBe(close());
    const last = controls().at(-1)!;
    last.focus();
    press(last, "Tab");
    expect(document.activeElement).toBe(close());
    press(close(), "Tab", true);
    expect(document.activeElement).toBe(last);
  });

  it("pulls focus that reached the sidebar back inside", async () => {
    await open();
    opener.focus();
    press(opener, "Tab");
    expect(document.activeElement).toBe(close());
  });

  it("returns focus to whatever opened it", async () => {
    await open();
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });
});
