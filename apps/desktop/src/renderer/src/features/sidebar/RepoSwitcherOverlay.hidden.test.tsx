// @vitest-environment jsdom
//
// Main leaves a hidden repository out of ⌘K entirely. The palette brings one
// back only when the query names it in full, and offers the command that
// opens the sidebar's Hidden list.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type HiddenRepo, type RepoSearchHit } from "@pwrgit/shared";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: (command: string, req: unknown) =>
    command === "settings:read"
      ? Promise.resolve({ ok: true, value: { general: { searchAllProfiles: false } } })
      : dispatch(command, req),
  subscribe: () => () => {},
  windowProfileId: () => "work"
}));
const showHidden = vi.hoisted(() => vi.fn());
vi.mock("../../state/useHiddenRepos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/useHiddenRepos")>()),
  requestShowHiddenRepos: showHidden
}));

import { buildPaletteItems, namesShowHidden, RepoSwitcherOverlay } from "./RepoSwitcherOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const harbor: HiddenRepo = {
  profileId: "work",
  profileName: "Work",
  path: "/src/harbor-api",
  name: "harbor-api",
  hiddenAt: "2026-10-01T00:00:00.000Z",
  repoId: "harbor",
  worktreeCount: 3,
  missing: false
};
const scope = { entries: [harbor], profileName: "Work" };

describe("buildPaletteItems with hidden repositories", () => {
  it("adds a hidden repository only for its full name, in any case", () => {
    expect(buildPaletteItems([], [], "harbor", [], null, scope)).toEqual([]);
    expect(buildPaletteItems([], [], "HARBOR-API", [], null, scope)).toEqual([
      { kind: "hidden", entry: harbor }
    ]);
    // Gone from disk: nothing to unhide into.
    expect(
      buildPaletteItems([], [], "harbor-api", [], null, {
        ...scope,
        entries: [{ ...harbor, missing: true, repoId: null }]
      })
    ).toEqual([]);
  });

  it("offers the command while the query spells it, and only with something hidden", () => {
    expect(namesShowHidden("hidd")).toBe(true);
    expect(namesShowHidden("show hid")).toBe(true);
    expect(namesShowHidden("hid")).toBe(false);
    expect(namesShowHidden("hidden stuff")).toBe(false);
    expect(buildPaletteItems([], [], "show hidden", [], null, scope)).toEqual([
      { kind: "show-hidden", count: 1, profileName: "Work" }
    ]);
    expect(
      buildPaletteItems([], [], "show hidden", [], null, { entries: [], profileName: "" })
    ).toEqual([]);
  });
});

describe("RepoSwitcherOverlay hidden rows", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onPick = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    dispatch.mockImplementation((command: string) => {
      if (command === "repo:hiddenList") return Promise.resolve(ok([harbor]));
      if (command === "repo:search") return Promise.resolve(ok([] as RepoSearchHit[]));
      return Promise.resolve(ok(null));
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  async function typeQuery(value: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
  }

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <RepoSwitcherOverlay
          platform="darwin"
          commits={[]}
          commitContext={null}
          onClose={onClose}
          onPick={onPick}
          onPickCommit={vi.fn()}
          onPickFile={vi.fn()}
          profileCount={1}
        />
      );
    });
  }

  it("unhides on Return and opens the repository", async () => {
    await mount();
    await typeQuery("harbor-api");
    const row = container.querySelector<HTMLElement>(".overlay-result--hidden");
    expect(row?.textContent).toContain("harbor-api");
    expect(row?.textContent).toContain("Return to unhide");
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith("repo:unhide", {
      profileId: "work",
      path: "/src/harbor-api"
    });
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "repo", repoId: "harbor", name: "harbor-api" })
    );
  });

  it("opens the sidebar's Hidden list from the command", async () => {
    await mount();
    await typeQuery("show hidden");
    const row = container.querySelector<HTMLElement>(".overlay-result--command");
    expect(row?.textContent).toContain("Show hidden repositories");
    expect(row?.textContent).toContain("1 in Work");
    await act(async () => row?.click());
    expect(onClose).toHaveBeenCalled();
    expect(showHidden).toHaveBeenCalledTimes(1);
  });
});
