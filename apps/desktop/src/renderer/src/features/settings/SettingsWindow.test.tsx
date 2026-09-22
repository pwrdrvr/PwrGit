// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  FORGE_KINDS,
  GENERAL_DEFAULTS,
  forgeProduct,
  ok,
  type AcpAgentDiscovery,
  type AiProviderSettings,
  type AppSettingsSnapshot,
  type CodexProviderDiscovery,
  type ForgeStatus,
  type Profile,
  type Res
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
  subscribe: mocks.subscribe,
  // The Settings window is bound to no profile; `useProfiles` asks.
  windowProfileId: () => null
}));

import { SettingsWindow } from "./SettingsWindow";

/** General's Git runtime card reads this on mount, and General renders in every
 *  test. The catch-all `ok(undefined)` below is not a runtime status, and the
 *  card is right to trust the typed IPC rather than guard against one. */
const GIT_RUNTIME: Res<"git:runtimeStatus"> = {
  active: "bundled",
  path: "/fixture/git/bin/git",
  keychainHelper: null,
  candidates: [
    {
      path: "/fixture/git/bin/git",
      source: "bundled",
      git: "git version 2.50.9",
      lfs: "git-lfs/3.6.9",
      problem: null
    }
  ]
};
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

const PERSONAL: Profile = {
  id: "personal",
  name: "Personal",
  email: "me@example.com",
  mono: "P",
  roots: [],
  onboardingCompleted: true
};
const ACME: Profile = {
  id: "acme",
  name: "Acme",
  email: "me@acme.example",
  mono: "A",
  roots: [],
  onboardingCompleted: true
};

/** What the AI reads answer, per test. */
let aiSettings: AiProviderSettings;
let codexDiscovery: CodexProviderDiscovery;
let acpDiscovery: AcpAgentDiscovery;

function codex(overrides: Partial<CodexProviderDiscovery> = {}): CodexProviderDiscovery {
  return {
    candidates: [
      { path: "/opt/homebrew/bin/codex", source: "path", version: "0.200.0", available: true }
    ],
    resolvedPath: "/opt/homebrew/bin/codex",
    auth: {
      status: "authenticated",
      profile: "",
      profileLabel: "System default",
      codexHome: "/Users/you/.codex",
      email: "dev@example.com"
    },
    refreshedAt: "2026-09-19T00:00:00.000Z",
    ...overrides
  };
}

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

/** Every read the window makes on open, answered from the fixtures above. */
async function answer(name: string, req?: unknown): Promise<unknown> {
  // General is the window's opening pane, so it renders in every test and
  // reads its half of the snapshot. No other pane here looks inside one.
  if (name === "settings:read") return ok(SNAPSHOT);
  if (name === "forge:status") return ok({ forges });
  if (name === "forge:hosts") return ok({ hosts: [], overrides: {} });
  if (name === "git:runtimeStatus") return ok(GIT_RUNTIME);
  if (name === "profile:list") {
    return ok({ activeProfileId: PERSONAL.id, profiles: [PERSONAL, ACME] });
  }
  const profileId = (req as { profileId?: string } | undefined)?.profileId;
  if (name === "aiProviders:read") return ok({ profileId, settings: aiSettings });
  if (name === "aiProviders:discoverCodex") return ok(codexDiscovery);
  if (name === "aiProviders:discoverAcp") return ok(acpDiscovery);
  if (name === "aiProviders:codexAuthProfiles") {
    return ok({
      profiles: [
        {
          name: "",
          displayName: "System default",
          codexHome: "/Users/you/.codex",
          hasAuthFile: true,
          email: "dev@example.com"
        }
      ],
      followed: ""
    });
  }
  if (name === "aiProviders:codexModels") return ok({ models: [] });
  return ok(undefined);
}

beforeEach(() => {
  // The Forges pane's real id is `forges` and collapse state is module-level,
  // so a fold made in one test is the next one's starting state.
  __resetCollapsedPanesForTests();
  installBridge();
  vi.clearAllMocks();
  forges = [];
  aiSettings = DEFAULT_AI_PROVIDER_SETTINGS;
  codexDiscovery = codex();
  acpDiscovery = {
    agents: [
      {
        id: "grok",
        displayName: "Grok",
        installed: true,
        version: "1.2.0",
        instances: [{ command: "/usr/local/bin/grok", version: "1.2.0", source: "path" }],
        activeCommand: "/usr/local/bin/grok"
      },
      {
        id: "kimi",
        displayName: "Kimi Code CLI",
        installed: false,
        detail: "Install Kimi Code CLI",
        instances: []
      },
      {
        id: "qwen",
        displayName: "Qwen Code",
        installed: false,
        detail: "Install Qwen Code",
        instances: []
      }
    ]
  };
  window.location.hash = "#settings";
  mocks.subscribe.mockReturnValue(() => {});
  mocks.dispatch.mockImplementation(answer);
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
      ...sublist("forges").querySelectorAll(".settings-nav__sublabel")
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
  it("keeps GitCafe's nav current through installation, login and enable changes", async () => {
    await render();
    const child = navChild("GitCafe");
    expect(dotTone(child)).toBeUndefined();
    const listener = mocks.subscribe.mock.calls.find(
      ([name]) => name === "forge:statusChanged"
    )?.[1];
    expect(listener).toBeTypeOf("function");
    const cases: { status: Partial<ForgeStatus>; tone: string; word?: string; label: string }[] = [
      { status: { installed: false, loggedIn: false }, tone: "bad", word: "missing", label: "Not installed" },
      { status: { loggedIn: false }, tone: "warn", word: "sign in", label: "Signed out" },
      { status: { loggedIn: true }, tone: "ok", label: "Connected" },
      { status: { loggedIn: false, hosts: [{ host: "git.cafe", enabled: false, loggedIn: true }] }, tone: "off", word: "off", label: "Off" },
      { status: { loggedIn: true }, tone: "ok", label: "Connected" }
    ];
    for (const { status, tone, word, label } of cases) {
      forges = [forge({ kind: "gitcafe", ...status })];
      await act(async () => listener({ forges }));
      expect(dotTone(child)).toBe(tone);
      expect(chip(child)).toBe(word);
      expect(child.getAttribute("aria-label")).toBe(`GitCafe: ${label}`);
    }
    await act(async () => child.click());
    expect(card("GitCafe").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(card("GitCafe"));
    expect(child.getAttribute("aria-current")).toBe("page");
  });

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
    mocks.dispatch.mockImplementation(async (name: string, req: unknown) =>
      name === "forge:status" ? new Promise(() => {}) : answer(name, req)
    );
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

describe("Settings nav — AI", () => {
  /** Every name `dispatch` was called with, in order. */
  function dispatched(): string[] {
    return mocks.dispatch.mock.calls.map(([name]) => String(name));
  }

  it("names Local Agents apart from the two AI pages", async () => {
    // Agents calling IN (MCP) and agents PwrGit calls OUT to share a word and
    // nothing else; a bare "Agents" beside "AI Providers" reads as either.
    await render();

    const rows = [
      ...container.querySelectorAll(".settings-nav__button")
    ].map((node) => node.textContent?.trim());
    expect(rows).toContain("AI Providers");
    expect(rows).toContain("AI Features");
    expect(rows).toContain("Local Agents");
    expect(rows).not.toContain("Agents");
  });

  it("probes nothing until the reader goes near AI", async () => {
    await render();
    expect(dispatched()).not.toContain("aiProviders:discoverCodex");
    expect(dispatched()).not.toContain("aiProviders:discoverAcp");

    await act(async () => navButton("AI Providers").click());

    expect(dispatched()).toContain("aiProviders:discoverCodex");
    expect(dispatched()).toContain("aiProviders:discoverAcp");
  });

  it("gives AI Providers a child per provider, with no Gemini", async () => {
    await render();
    await act(async () => navButton("AI Providers").click());

    const labels = [
      ...sublist("ai-providers").querySelectorAll(".settings-nav__sublabel")
    ].map((node) => node.textContent?.trim());
    expect(labels).toEqual(["Codex", "Grok", "Kimi Code CLI", "Qwen Code"]);
    expect(container.textContent).not.toMatch(/gemini/i);
  });

  it("reports each provider's state from the same read as its card", async () => {
    codexDiscovery = codex({
      auth: {
        status: "unauthenticated",
        profile: "",
        profileLabel: "System default",
        codexHome: "/Users/you/.codex"
      }
    });
    aiSettings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["grok"], agents: {} }
    };
    await render();
    await act(async () => navButton("AI Providers").click());

    const codexRow = navChild("Codex");
    expect(dotTone(codexRow)).toBe("warn");
    expect(chip(codexRow)).toBe("sign in");
    expect(codexRow.getAttribute("aria-label")).toBe("Codex: Sign in");
    // The card says the same thing in its chip.
    expect(card("Codex").textContent).toContain("Sign in");

    // Enabled and installed: fine, so a dot and no word.
    expect(dotTone(navChild("Grok"))).toBe("ok");
    expect(chip(navChild("Grok"))).toBeUndefined();
    // Not enabled, not installed: grey, and says which.
    expect(dotTone(navChild("Kimi Code CLI"))).toBe("off");
    expect(chip(navChild("Kimi Code CLI"))).toBe("missing");
  });

  it("gives AI Features a jump link per section", async () => {
    await render();
    await act(async () => navButton("AI Features").click());

    const labels = [
      ...sublist("ai-features").querySelectorAll(".settings-nav__sublabel")
    ].map((node) => node.textContent?.trim());
    expect(labels).toEqual(["Availability", "Default agents", "Guidance"]);
    await act(async () => navChild("Guidance").click());
    expect(navChild("Guidance").getAttribute("aria-current")).toBe("page");
  });

  it("boots on a deep link: page, card and profile", async () => {
    window.location.hash = "#settings?page=ai-features&sub=guidance&profile=acme";
    await render();

    expect(sublist("ai-features").hasAttribute("inert")).toBe(false);
    expect(navChild("Guidance").getAttribute("aria-current")).toBe("page");
    expect(card("Guidance")).toBeDefined();
    // The AI pages edit the profile the link named, not the active one.
    const picker = container.querySelector<HTMLSelectElement>(
      "select[aria-label='Profile these AI settings belong to']"
    );
    expect(picker?.value).toBe("acme");
    expect(mocks.dispatch).toHaveBeenCalledWith("aiProviders:read", { profileId: "acme" });
  });

  it("follows settings:navigate when the window is already open", async () => {
    let navigate: ((route: unknown) => void) | undefined;
    mocks.subscribe.mockImplementation((channel: string, handler: (route: unknown) => void) => {
      if (channel === "settings:navigate") navigate = handler;
      return () => {};
    });
    await render();
    expect(navigate).toBeDefined();

    await act(async () => navigate?.({ page: "ai-providers", sub: "codex", profileId: "acme" }));

    expect(navChild("Codex").getAttribute("aria-current")).toBe("page");
    expect(mocks.dispatch).toHaveBeenCalledWith("aiProviders:read", { profileId: "acme" });
  });
});
