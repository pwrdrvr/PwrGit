// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORGE_KINDS,
  GENERAL_DEFAULTS,
  forgeProduct,
  ok,
  type AppSettingsSnapshot,
  type ForgeStatus
} from "@pwrgit/shared";

// Without this React warns on every `act`, and the warning is the only thing
// that tells you a state update escaped one.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { SettingsWindow } from "./SettingsWindow";
import { __resetCollapsedPanesForTests } from "./SettingsLayout";

/**
 * The Settings nav's group rows and their children.
 *
 * A child is not a pane: it names a card inside the parent's pane, scrolls to
 * it, and reports that card's state in the nav so an operator can answer "is
 * GitHub connected?" without opening anything. Both halves of that are what
 * this file pins — the routing, and the status that makes the row worth having.
 */
let container: HTMLDivElement;
let root: Root;
/** What `forge:status` answers. Empty means "probed, nothing installed"; the
 *  unprobed case is its own test, which never resolves the read. */
let forges: ForgeStatus[];

const SNAPSHOT = { general: GENERAL_DEFAULTS } as AppSettingsSnapshot;

/** A status shaped the way main's probe shapes one, as `ForgesSettings.test`
 *  shapes it — `hosts` derived from the same values the summary reads. */
function forge(overrides: Partial<ForgeStatus> = {}): ForgeStatus {
  const kind = overrides.kind ?? "github";
  const installed = overrides.installed ?? true;
  const loggedIn = overrides.loggedIn ?? true;
  const product = forgeProduct(kind);
  return {
    kind,
    cli: product.cli,
    installed,
    loggedIn,
    capabilities: {
      batchedBranchLookup: true,
      batchedCommitAssociation: true,
      changeSizeAndTimeline: true,
      commitAuthorIdentity: true,
      forkDefaultBranchOnly: true
    },
    hosts: installed
      ? [{ host: product.saasHost, enabled: true, loggedIn }]
      : [],
    ...overrides
  };
}

/**
 * The preload bridge, for the fields the panes read off it directly.
 *
 * `lib/pwrgit` is mocked, so `dispatch` and `on` here are never called — but
 * General reads `platform` straight from the bridge, and jsdom's window carries
 * no `pwrgit` at all.
 */
function installBridge(): void {
  (window as Window & { pwrgit: Window["pwrgit"] }).pwrgit = {
    profileId: null,
    platform: "darwin",
    appearance: { theme: "dark", resolvedTheme: "dark" },
    getAppMenuModel: async () => [],
    popupAppMenu: () => {},
    runWindowControl: async () => undefined,
    readWindowFrameState: async () => null,
    onWindowFrameState: () => () => {},
    dispatch: async () => ok(undefined),
    on: () => () => {}
  };
}

beforeEach(() => {
  // The Forges pane's real id is `forges` and collapse state is module-level,
  // so a fold made in one test is the next one's starting state.
  __resetCollapsedPanesForTests();
  installBridge();
  vi.clearAllMocks();
  forges = [];
  mocks.subscribe.mockReturnValue(() => {});
  mocks.dispatch.mockImplementation(async (name: string) => {
    // General is the window's opening pane, so it renders in every test and
    // reads its half of the snapshot. No other pane here looks inside one.
    if (name === "settings:read") return ok(SNAPSHOT);
    if (name === "forge:status") return ok({ forges });
    if (name === "forge:hosts") return ok({ hosts: [], overrides: {} });
    return ok(undefined);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // Torn down, as `lib/pwrgit.test.ts` tears its bridge down: left installed it
  // outlives every test in the file, so one that means to assert behaviour with
  // no bridge present would silently get this one instead.
  // `Reflect.deleteProperty`, not `delete`: the bridge is declared non-optional
  // on `Window`, so `delete window.pwrgit` is a type error however it is cast.
  Reflect.deleteProperty(window, "pwrgit");
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<SettingsWindow />);
  });
}

function navButton(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>(".settings-nav__button")
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no nav row "${label}"`);
  return found;
}

/** Addressed by its visible label, never its accessible name — the name is the
 *  thing under test in the rows that carry a state. */
function navChild(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>(".settings-nav__subbutton")
  ].find(
    (candidate) =>
      candidate.querySelector(".settings-nav__sublabel")?.textContent?.trim() ===
      label
  );
  if (found === undefined) throw new Error(`no nav child "${label}"`);
  return found;
}

function sublist(section: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `#settings-nav-sublist-${section}`
  );
  if (found === null) throw new Error(`no sublist for ${section}`);
  return found;
}

/** One product card's disclosure header, inside the pane. */
function card(title: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[role='button'][aria-label='${title}']`
  );
  if (found === null) throw new Error(`no card for ${title}`);
  return found;
}

function dotTone(child: HTMLElement): string | undefined {
  const dot = child.querySelector(".settings-nav__subdot");
  return [...(dot?.classList ?? [])]
    .find((name) => name.startsWith("settings-nav__subdot--"))
    ?.replace("settings-nav__subdot--", "");
}

function chip(child: HTMLElement): string | undefined {
  return (
    child.querySelector(".settings-nav__subchip")?.textContent?.trim() ??
    undefined
  );
}

describe("Settings nav — groups", () => {
  it("gives Forges a child per product, from the registry", async () => {
    // Driven from `FORGE_KINDS` rather than a pair written here, so a third
    // product reaches the nav the same way it reaches the pane — as a registry
    // entry, not an edit to the nav.
    await render();

    const labels = [
      ...container.querySelectorAll(".settings-nav__sublabel")
    ].map((node) => node.textContent?.trim());
    expect(labels).toEqual(FORGE_KINDS.map((kind) => forgeProduct(kind).label));
  });

  it("starts folded, with its children out of the tab order", async () => {
    // `aria-hidden` alone would leave them focusable, so Tab would walk into a
    // folded group and land on something nobody can see.
    await render();

    expect(sublist("forges").hasAttribute("inert")).toBe(true);
    expect(sublist("forges").getAttribute("aria-hidden")).toBe("true");
  });

  it("reveals the children when the section itself is opened", async () => {
    // The discoverability rule: a reader who clicks "Forges" and never thinks
    // to look for a caret still finds out the section has parts.
    await render();
    await act(async () => navButton("Forges").click());

    expect(sublist("forges").hasAttribute("inert")).toBe(false);
  });

  it("folds from the caret without leaving the pane", async () => {
    await render();
    await act(async () => navButton("Forges").click());

    const caret = container.querySelector<HTMLButtonElement>(
      ".settings-nav__caret"
    );
    await act(async () => caret?.click());

    expect(sublist("forges").hasAttribute("inert")).toBe(true);
    // Still the section on screen — the caret is a disclosure, not a route.
    expect(navButton("Forges").getAttribute("aria-current")).toBe("page");
  });

  it("hands the marker back to the parent when the group is folded", async () => {
    // A folded group hides its `aria-current` child inside an inert sublist. If
    // the parent did not take the marker over, the nav would show the reader
    // nowhere at all.
    await render();
    const github = forgeProduct(FORGE_KINDS[0]).label;
    await act(async () => navChild(github).click());
    expect(navButton("Forges").getAttribute("aria-current")).toBeNull();

    const caret = container.querySelector<HTMLButtonElement>(
      ".settings-nav__caret"
    );
    await act(async () => caret?.click());

    expect(navButton("Forges").getAttribute("aria-current")).toBe("page");
  });

  it("never marks two rows as the current page", async () => {
    // Handing the marker over has to be a MOVE, not a copy. The folded child
    // kept its own `aria-current` at first, so two rows claimed to be the
    // current page — hidden from AT only by the sublist's `aria-hidden`.
    const [first] = FORGE_KINDS;
    if (first === undefined) return;
    await render();
    await act(async () => navChild(forgeProduct(first).label).click());
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);

    const caret = container.querySelector<HTMLButtonElement>(
      ".settings-nav__caret"
    );
    await act(async () => caret?.click());

    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(navButton("Forges").getAttribute("aria-current")).toBe("page");
  });
});

describe("Settings nav — forge status", () => {
  it("reports each product's state in a dot and a word", async () => {
    const [first, second] = FORGE_KINDS;
    if (first === undefined || second === undefined) return;
    forges = [
      forge({ kind: first }),
      forge({ kind: second, installed: false, loggedIn: false })
    ];
    await render();

    const connected = navChild(forgeProduct(first).label);
    expect(dotTone(connected)).toBe("ok");
    // The one state that needs nothing is the one allowed to stay quiet.
    expect(chip(connected)).toBeUndefined();

    const missing = navChild(forgeProduct(second).label);
    expect(dotTone(missing)).toBe("bad");
    expect(chip(missing)).toBe("missing");
  });

  it("tells a forge somebody switched off from one that is broken", async () => {
    // The distinction these rows exist to make: "you turned this off" is a
    // working configuration, "sign in" is an errand.
    const [first, second] = FORGE_KINDS;
    if (first === undefined || second === undefined) return;
    const product = forgeProduct(first);
    forges = [
      forge({
        kind: first,
        loggedIn: false,
        hosts: [{ host: product.saasHost, enabled: false, loggedIn: true }]
      }),
      forge({ kind: second, loggedIn: false })
    ];
    await render();

    expect(dotTone(navChild(product.label))).toBe("off");
    expect(chip(navChild(product.label))).toBe("off");

    const signedOut = navChild(forgeProduct(second).label);
    expect(dotTone(signedOut)).toBe("warn");
    expect(chip(signedOut)).toBe("sign in");
  });

  it("names the row's condition in words, because the dot is aria-hidden", async () => {
    const [first] = FORGE_KINDS;
    if (first === undefined) return;
    forges = [forge({ kind: first, loggedIn: false })];
    await render();

    const child = navChild(forgeProduct(first).label);
    expect(child.querySelector(".settings-nav__subdot")?.getAttribute("aria-hidden")).toBe("true");
    // The visible label is contained in the accessible name (SC 2.5.3), and
    // the chip's fragment never becomes the name on its own.
    expect(child.getAttribute("aria-label")).toBe(
      `${forgeProduct(first).label}: Signed out`
    );
  });

  it("shows nothing at all until a probe has answered", async () => {
    // "We do not know" is honest; a neutral dot would be a guess and a green
    // one a wrong guess. The row's name stays the bare product label.
    mocks.dispatch.mockImplementation(async (name: string) => {
      if (name === "settings:read") return ok(SNAPSHOT);
      if (name === "forge:status") return new Promise(() => {});
      return ok(undefined);
    });
    await render();

    const [first] = FORGE_KINDS;
    if (first === undefined) return;
    const child = navChild(forgeProduct(first).label);
    // The dot's lane is still held — that is what keeps the label from jogging
    // sideways when the probe lands — but nothing is painted in it.
    expect(dotTone(child)).toBeUndefined();
    expect(child.querySelector(".settings-nav__subchip")).toBeNull();
    expect(child.getAttribute("aria-label")).toBeNull();
  });
});

describe("Settings nav — reveal", () => {
  it("opens the pane and unfolds that product's card", async () => {
    const [first] = FORGE_KINDS;
    if (first === undefined) return;
    const label = forgeProduct(first).label;
    forges = FORGE_KINDS.map((kind) => forge({ kind }));
    await render();

    // Get the pane on screen and fold the card, so the reveal has something to
    // undo — sections open expanded, and an assertion on an already-open card
    // would pass without the nav doing anything.
    await act(async () => navButton("Forges").click());
    await act(async () => card(label).click());
    expect(card(label).getAttribute("aria-expanded")).toBe("false");

    await act(async () => navChild(label).click());

    expect(card(label).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(card(label));
  });

  it("marks the child the reader is on, and only that one", async () => {
    const [first, second] = FORGE_KINDS;
    if (first === undefined || second === undefined) return;
    await render();
    await act(async () => navChild(forgeProduct(first).label).click());

    expect(
      navChild(forgeProduct(first).label).getAttribute("aria-current")
    ).toBe("page");
    expect(
      navChild(forgeProduct(second).label).getAttribute("aria-current")
    ).toBeNull();
  });

  it("drops the child marker when the parent row is clicked", async () => {
    // Clicking "Forges" is a route to the pane as a whole, not to the card the
    // reader happened to be on last.
    const [first] = FORGE_KINDS;
    if (first === undefined) return;
    await render();
    await act(async () => navChild(forgeProduct(first).label).click());

    await act(async () => navButton("Forges").click());

    expect(
      navChild(forgeProduct(first).label).getAttribute("aria-current")
    ).toBeNull();
    expect(navButton("Forges").getAttribute("aria-current")).toBe("page");
  });
});
