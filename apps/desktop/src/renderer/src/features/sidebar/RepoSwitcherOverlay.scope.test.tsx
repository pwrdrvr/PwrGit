// @vitest-environment jsdom
//
// The search line: the scope control (this profile, or every profile) and the
// close button. The scope writes the same setting as Settings → General →
// Search all profiles, and the search it triggers carries the scope shown.
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
const onClose = vi.fn();

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
        commits={[]} commitContext={null} onClose={onClose} onPick={() => {}}
        onPickCommit={() => {}} onPickFile={() => {}}
        platform={platform} profileCount={profileCount}
      />
    );
  });
}
const option = (label: "This profile" | "All profiles") =>
  [...container.querySelectorAll<HTMLButtonElement>(
    '[role="radiogroup"][aria-label="Search scope"] [role="radio"]'
  )].find((radio) => radio.textContent === label);
/** Which option is checked, or null when the control is not there. */
const scope = () =>
  option("All profiles") === undefined
    ? null
    : option("All profiles")!.getAttribute("aria-checked") === "true"
      ? "all"
      : "this";
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
  expect(
    container
      .querySelector('[role="radiogroup"][aria-label="Search scope"]')
      ?.getAttribute("aria-keyshortcuts")
  ).toBe("Meta+Shift+A");
  expect(scope()).toBe("this");
  expect(option("This profile")?.getAttribute("aria-checked")).toBe("true");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: false });
});

it("widens on click, saves the setting, and searches with the new scope", async () => {
  await render();
  await act(async () => option("All profiles")!.click());
  expect(scope()).toBe("all");
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
  expect(scope()).toBe("all");
  await press({ key: "A", shiftKey: true, ...modifier });
  expect(scope()).toBe("this");
  expect(stored).toBe(false);
});

it("opens widened when the setting already is", async () => {
  stored = true;
  await render();
  expect(scope()).toBe("all");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: true });
});

it("follows a change made in Settings while the palette is open", async () => {
  await render();
  await act(async () => mocks.changed?.(snapshot(true)));
  expect(scope()).toBe("all");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: true });
});

it("goes back when the setting could not be saved", async () => {
  saveFails = true;
  await render();
  await act(async () => option("All profiles")!.click());
  expect(scope()).toBe("this");
  expect(lastSearch()).toEqual({ query: "", profileId: "ours", allProfiles: false });
});

// With one profile, both scopes are the same search: no control, no shortcut.
it("has no toggle with only one profile", async () => {
  await render(1);
  expect(scope()).toBeNull();
  await press({ key: "A", shiftKey: true, metaKey: true });
  expect(updates()).toEqual([]);
});

it("leaves the setting alone when the chosen option is clicked again", async () => {
  await render();
  await act(async () => option("This profile")!.click());
  expect(updates()).toEqual([]);
});

it("closes from the round close button, which names its key", async () => {
  await render();
  const close = container.querySelector<HTMLButtonElement>(
    '.overlay-search button[aria-label="Close"]'
  );
  expect(close).not.toBeNull();
  await act(async () => close!.click());
  expect(onClose).toHaveBeenCalledOnce();
});
