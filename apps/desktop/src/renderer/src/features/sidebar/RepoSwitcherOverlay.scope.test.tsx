// @vitest-environment jsdom
//
// The footer's scope toggle: this profile, or every profile. It writes the
// same setting as Settings → General → Search all profiles, and the search it
// triggers carries the scope the footer shows.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { err, ok, type AppSettingsSnapshot, type RepoSearchHit } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  changed: null as ((snapshot: AppSettingsSnapshot) => void) | null
}));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: (_event: string, listener: (snapshot: AppSettingsSnapshot) => void) => {
    mocks.changed = listener;
    return () => {
      mocks.changed = null;
    };
  },
  windowProfileId: () => "ours"
}));
import { RepoSwitcherOverlay } from "./RepoSwitcherOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = (searchAllProfiles: boolean) =>
  ({ general: { searchAllProfiles } }) as AppSettingsSnapshot;
const hit: RepoSearchHit = {
  kind: "repo", repoId: "demo", name: "demo", path: "/repos/demo",
  profileId: "ours", profileName: "Ours", worktreeCount: 1, pinned: false
};

let container: HTMLDivElement;
let root: Root;
let stored: boolean;
let saveFails: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  stored = false;
  saveFails = false;
  mocks.dispatch.mockImplementation(async (command: string, req: unknown) => {
    if (command === "settings:read") return ok(snapshot(stored));
    if (command === "settings:update") {
      if (saveFails) return err({ kind: "internal", message: "disk full" });
      stored = (req as { patch: { general: { searchAllProfiles: boolean } } })
        .patch.general.searchAllProfiles;
      return ok(snapshot(stored));
    }
    return ok([hit]);
  });
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
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

async function render(profileCount = 2, platform = "darwin") {
  await act(async () => {
    root.render(
      <RepoSwitcherOverlay
        commits={[]} commitContext={null} onClose={() => {}} onPick={() => {}}
        onPickCommit={() => {}} onPickFile={() => {}}
        platform={platform} profileCount={profileCount}
      />
    );
  });
}
const toggle = () =>
  container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Search all profiles"]'
  );
const lastSearch = () =>
  mocks.dispatch.mock.calls.filter(([command]) => command === "repo:search").at(-1)?.[1];
const updates = () =>
  mocks.dispatch.mock.calls.filter(([command]) => command === "settings:update");
async function press(init: KeyboardEventInit) {
  await act(async () => {
    container.querySelector("input")!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    );
  });
}

it("starts on this profile, and says so", async () => {
  await render();
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(toggle()?.textContent).toContain("This profile");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: false });
});

it("widens on click, saves the setting, and searches with the new scope", async () => {
  await render();
  await act(async () => toggle()!.click());
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  expect(toggle()?.textContent).toContain("All profiles");
  expect(updates()).toEqual([
    ["settings:update", { patch: { general: { searchAllProfiles: true } } }]
  ]);
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: true });
});

it.each([
  ["darwin", { metaKey: true }],
  ["linux", { ctrlKey: true }]
] as const)("toggles from the keyboard on %s", async (platform, modifier) => {
  await render(2, platform);
  await press({ key: "A", shiftKey: true, ...modifier });
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  await press({ key: "A", shiftKey: true, ...modifier });
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(stored).toBe(false);
});

it("opens widened when the setting already is", async () => {
  stored = true;
  await render();
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: true });
});

it("follows a change made in Settings while the palette is open", async () => {
  await render();
  await act(async () => mocks.changed?.(snapshot(true)));
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: true });
});

it("goes back when the setting could not be saved", async () => {
  saveFails = true;
  await render();
  await act(async () => toggle()!.click());
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: false });
});

// With one profile, both scopes are the same search: no control, no shortcut.
it("has no toggle with only one profile", async () => {
  await render(1);
  expect(toggle()).toBeNull();
  await press({ key: "A", shiftKey: true, metaKey: true });
  expect(updates()).toEqual([]);
});
