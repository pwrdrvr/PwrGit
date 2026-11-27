// @vitest-environment jsdom

import { act } from "react";
import fc from "fast-check";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORGE_KINDS,
  GENERAL_DEFAULTS,
  DIAGNOSTICS_DEFAULTS,
  forgeProduct,
  ok,
  type AppSettingsSnapshot,
  type Req,
  type ForgeStatus,
  type MachineGitIdentity,
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
  dispatchOrThrow: async (name: string, req?: unknown) => {
    const result = await mocks.dispatch(name, req);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  },
  subscribe: mocks.subscribe,
  // The Settings window is bound to no profile; `useProfiles` asks.
  windowProfileId: () => null
}));

import { SettingsWindow } from "./SettingsWindow";

/** The Git page's probe, which runs only once the reader goes near Git. The
 *  catch-all `ok(undefined)` below is not a runtime status, and the card is
 *  right to trust the typed IPC rather than guard against one. */
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

/** PwrGit’s Git: read by the window on open (a file read, never the network),
 *  because the Git group's nav child reports on it. */
let managedGit: Res<"gitManaged:status">;
const NO_NEWER_GIT: Res<"gitManaged:status"> = {
  supported: true,
  bundledVersion: "2.56.0-dev-pwrgit.4",
  track: "latest",
  tracks: { latest: null, prerelease: null },
  latest: null,
  needsAppUpdate: null,
  checkedAt: null,
  checkError: null,
  builds: [],
  selected: null,
  previous: null,
  inUse: false,
  selectedError: null,
  progress: null
};

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

const SNAPSHOT = {
  general: GENERAL_DEFAULTS,
  diagnostics: DIAGNOSTICS_DEFAULTS,
  diagnosticsEnv: { heapMonitorForcedOn: false, hotCpuProfilingForcedOn: false, startupCpuProfilingForcedOn: false },
  diagnosticsOutputRoot: "/demo/diagnostics"
} as AppSettingsSnapshot;

const PERSONAL: Profile = {
  id: "personal",
  name: "Personal",
  email: "me@example.com",
  mono: "P",
  roots: [],
  onboardingCompleted: true,
  showInMenu: true
};
const ACME: Profile = {
  id: "acme",
  name: "Acme",
  email: "me@acme.example",
  mono: "A",
  roots: [],
  onboardingCompleted: true,
  showInMenu: true
};

const CONFIGURED_GIT: MachineGitIdentity = {
  outside: {
    kind: "configured",
    author: { name: "Rowan Vale", email: "rowan@vale.example" },
    committer: { name: "Rowan Vale", email: "rowan@vale.example" }
  },
  config: [],
  globalFile: "/Users/you/.gitconfig",
  notice: false
};
let machineIdentity: MachineGitIdentity;
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
      commitSignatures: true,
      forkDefaultBranchOnly: true,
      addToMergeQueue: false
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
async function answer(name: string): Promise<unknown> {
  // General is the window's opening pane, so it renders in every test and
  // reads its half of the snapshot. No other pane here looks inside one.
  if (name === "settings:read") return ok(SNAPSHOT);
  if (name === "app:readProcessIds") return ok({ line: "main=4200 renderer=4201", diagnosticsText: "Demo process IDs" });
  if (name === "forge:status") return ok({ forges });
  if (name === "forge:hosts") return ok({ hosts: [], overrides: {} });
  if (name === "git:runtimeStatus") return ok(GIT_RUNTIME);
  if (name === "gitManaged:status" || name === "gitManaged:check") return ok(managedGit);
  if (name === "identity:machine") return ok(machineIdentity);
  if (name === "localAgents:read") return ok({ sessions: [], roles: [], policyFile: "/demo/mcp-policy.json" });
  if (name === "agentAccess:read") return ok({ enabled: false, listening: false });
  if (name === "repo:hiddenList") return ok([]);
  if (name === "identity:folders") {
    return ok({ enabled: false, globalFile: "/home/rowan/.gitconfig", machine: machineIdentity.outside, profiles: [] });
  }
  if (name === "profile:list") {
    return ok({ activeProfileId: PERSONAL.id, profiles: [PERSONAL, ACME] });
  }
  return ok(undefined);
}

beforeEach(() => {
  // The Forges pane's real id is `forges` and collapse state is module-level,
  // so a fold made in one test is the next one's starting state.
  __resetCollapsedPanesForTests();
  installBridge();
  vi.clearAllMocks();
  forges = [];
  managedGit = NO_NEWER_GIT;
  machineIdentity = CONFIGURED_GIT;
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

it("keeps resource recording off until explicitly toggled in Troubleshooting", async () => {
  mocks.dispatch.mockImplementation(async (name, req) => {
    if (name === "settings:update") {
      return ok({ ...SNAPSHOT, diagnostics: { ...DIAGNOSTICS_DEFAULTS, ...req.patch.diagnostics } });
    }
    return answer(name);
  });
  await render();
  await act(async () => navButton("Troubleshooting").click());
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Record resource usage for 24 hours"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
  for (const enabled of [true, false]) {
    await act(async () => toggle!.click());
    expect(mocks.dispatch).toHaveBeenCalledWith("settings:update", { patch: { diagnostics: { resourceUsageEnabled: enabled } } });
    expect(toggle?.getAttribute("aria-checked")).toBe(String(enabled));
  }
});

async function editRulesWhileThresholdSaves(
  thresholdPercent: number, nextEdit: "toggle" | "duration" | "mode" | "threshold", finishFirstWriteBeforeEdit: boolean
) {
  // The model accepts one complete rules value per IPC write and can delay
  // its acknowledgement across the next gesture.
  let stored = SNAPSHOT;
  const writes: Array<() => void> = [];
  mocks.dispatch.mockImplementation(async (name, req: Req<"settings:update">) => {
    if (name !== "settings:update") return answer(name);
    return new Promise((resolve) => writes.push(() => {
      stored = { ...stored, diagnostics: { ...stored.diagnostics, ...req.patch.diagnostics } };
      resolve(ok(stored));
    }));
  });
  try {
    await render();
    await act(async () => navButton("Troubleshooting").click());
    const group = container.querySelector('[role="group"].settings-cpu-rules')!;
    const threshold = group.querySelector<HTMLInputElement>('input[aria-label="Sustained threshold percent"]')!;
    const typeThreshold = (value: number) => {
      threshold.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(threshold, String(value));
      threshold.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => typeThreshold(thresholdPercent));
    const slowburn = [...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((control) => control.parentElement?.textContent === "Slow burn")!;
    const duration = group.querySelector<HTMLSelectElement>('select[aria-label="Sustained duration"]')!;
    const spike = [...group.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
      .find((control) => control.textContent === "Spike")!;
    const target = { toggle: slowburn, duration, mode: spike, threshold: slowburn }[nextEdit];
    // Pointer-down moves focus and causes a blur before pointer-up and click.
    await act(async () => target.focus());
    expect(writes).toHaveLength(1);
    if (finishFirstWriteBeforeEdit) await act(async () => writes.shift()!());
    if (nextEdit === "threshold") await act(async () => typeThreshold(50));
    await act(async () => {
      if (nextEdit === "threshold") {
        target.focus();
      } else if (nextEdit === "duration") {
        duration.value = "6000";
        duration.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        target.click();
      }
    });
    if (!finishFirstWriteBeforeEdit) {
      // Only the threshold can be in flight. The next update must apply to
      // the acknowledged snapshot, or the full-rules write loses a field.
      expect(writes).toHaveLength(1);
      await act(async () => writes.shift()!());
    }
    expect(writes).toHaveLength(1);
    await act(async () => writes.shift()!());

    const rules = stored.diagnostics.hotCpuProfilingRules;
    expect(rules.sustained.thresholdPercent).toBe(nextEdit === "threshold" ? 50 : thresholdPercent);
    expect(rules.sustained.durationMs).toBe(nextEdit === "duration" ? 6000 : 4000);
    expect(rules.slowburn.enabled).toBe(nextEdit === "toggle");
    expect(rules.high.mode).toBe(nextEdit === "mode" ? "spike" : "sustained");
  } finally {
    await act(async () => root.unmount());
    root = createRoot(container);
  }
}

it("saves a threshold on blur and keeps a click on Slow burn during the write", async () => {
  await editRulesWhileThresholdSaves(74, "toggle", false);
});

it("preserves both rule edits whether the threshold write settles before or after the next gesture", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 51, max: 400 }),
    fc.constantFrom("toggle" as const, "duration" as const, "mode" as const, "threshold" as const),
    fc.boolean(),
    editRulesWhileThresholdSaves
  ), { numRuns: 15 });
});

it("shows when a resource recording stops, and turns the switch off when main ends it", async () => {
  const expiresAt = "2026-11-21T18:43:00.000Z";
  mocks.dispatch.mockImplementation(async (name) =>
    name === "settings:read"
      ? ok({ ...SNAPSHOT, diagnostics: { ...DIAGNOSTICS_DEFAULTS, resourceUsageEnabled: true, resourceUsageExpiresAt: expiresAt } })
      : answer(name));
  await render();
  await act(async () => navButton("Troubleshooting").click());
  const section = () => container.querySelector<HTMLElement>('section[aria-label="Resource Usage Recording"]')!;
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Record resource usage for 24 hours"]')!;
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  const stop = new Date(expiresAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  expect(section().textContent).toContain(`Stops automatically ${stop}`);
  expect(section().textContent).toContain("turns itself off 24 hours after it starts");

  // Main's expiry: settings:changed with the recording off and no stop time.
  const changed = mocks.subscribe.mock.calls.filter(([name]) => name === "settings:changed").map(([, handler]) => handler);
  expect(changed.length).toBeGreaterThan(0);
  await act(async () => {
    for (const handler of changed) handler({ ...SNAPSHOT, diagnostics: { ...DIAGNOSTICS_DEFAULTS } });
  });
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(section().textContent).not.toContain("Stops automatically");
});

it("labels startup profiling as one launch, with no reminder to turn it back off", async () => {
  mocks.dispatch.mockImplementation(async (name) =>
    name === "settings:read"
      ? ok({ ...SNAPSHOT, diagnostics: { ...DIAGNOSTICS_DEFAULTS, startupCpuProfilingEnabled: true } })
      : answer(name));
  await render();
  await act(async () => navButton("Troubleshooting").click());
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Profile next launch"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("the switch turns itself off as that launch starts");
  expect(container.textContent).not.toContain("Remember to turn this back off");
});

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
      '.settings-nav__caret[aria-controls="settings-nav-sublist-forges"]'
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
      '.settings-nav__caret[aria-controls="settings-nav-sublist-forges"]'
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
      '.settings-nav__caret[aria-controls="settings-nav-sublist-forges"]'
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
    mocks.dispatch.mockImplementation(async (name: string) =>
      name === "forge:status" ? new Promise(() => {}) : answer(name)
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

describe("Settings nav — Profiles and MCP", () => {
  it("opens Local Agents for MCP from the Settings nav", async () => {
    await render();
    await act(async () => navButton("Local Agents").click());
    expect(card("MCP server")).toBeDefined();
    expect(mocks.dispatch).toHaveBeenCalledWith("localAgents:read", undefined);
    expect(mocks.dispatch).toHaveBeenCalledWith("agentAccess:read", undefined);
  });

  it("warns on Profiles' Git row while Git outside PwrGit has no identity", async () => {
    await render();
    await act(async () => navButton("Profiles").click());
    // Configured: a plain jump link, like any other card.
    expect(dotTone(navChild("Git identity"))).toBeUndefined();

    machineIdentity = {
      ...CONFIGURED_GIT,
      outside: { kind: "guessed", author: { name: "Rowan Vale", email: "rowan@rowans-mbp.local" }, source: "system" }
    };
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await act(async () => navButton("Profiles").click());
    const row = navChild("Git identity");
    expect(dotTone(row)).toBe("warn");
    expect(chip(row)).toBe("guessed");
    expect(row.getAttribute("aria-label")).toBe("Git identity: Git is guessing your email");
    expect(navChild("Profile list")).toBeDefined();
    expect(navChild("Hidden repos")).toBeDefined();
  });

  it("follows settings:navigate when the window is already open", async () => {
    let navigate: ((route: unknown) => void) | undefined;
    mocks.subscribe.mockImplementation((channel: string, handler: (route: unknown) => void) => {
      if (channel === "settings:navigate") navigate = handler;
      return () => {};
    });
    await render();
    expect(navigate).toBeDefined();

    await act(async () => navigate?.({ page: "forges", sub: "github" }));

    expect(navChild("GitHub").getAttribute("aria-current")).toBe("page");
    expect(card("GitHub")).toBeDefined();
  });
});

describe("Settings nav — Git", () => {
  function dispatched(): string[] {
    return mocks.dispatch.mock.calls.map(([name]) => String(name));
  }

  it("sits right after General, and probes no Git until the reader goes near it", async () => {
    await render();
    const rows = [...container.querySelectorAll(".settings-nav__button")].map((row) => row.textContent?.trim());
    expect(rows.slice(0, 3)).toEqual(["General", "Git", "Updates"]);
    // General no longer holds the runtime card.
    expect(container.querySelector("section[aria-label='In use']")).toBeNull();
    expect(dispatched()).not.toContain("git:runtimeStatus");
    expect(dispatched()).not.toContain("gitManaged:check");

    await act(async () => navButton("Git").click());

    expect(dispatched()).toContain("git:runtimeStatus");
    const labels = [...sublist("git").querySelectorAll(".settings-nav__sublabel")].map((node) => node.textContent?.trim());
    expect(labels).toEqual(["In use", "PwrGit’s Git", "Installs"]);
    expect(container.querySelector("section[aria-label='In use']")).not.toBeNull();
    expect(dotTone(navChild("In use"))).toBe("ok");
  });

  it("says new beside PwrGit’s Git while a newer build waits, from the card's own answer", async () => {
    managedGit = {
      ...NO_NEWER_GIT,
      latest: { version: "2.56.0-dev-pwrgit.5", tag: "v2.56.0-dev-pwrgit.5", publishedAt: null, size: null },
      checkedAt: Date.now()
    };
    await render();
    await act(async () => navButton("Git").click());

    const child = navChild("PwrGit’s Git");
    expect(dotTone(child)).toBe("accent");
    expect(chip(child)).toBe("new");
    expect(child.getAttribute("aria-label")).toBe("PwrGit’s Git: Update available");
    expect(
      container.querySelector("section[aria-label='PwrGit’s Git'] .settings-panel__header .settings-card__chip")?.textContent
    ).toBe("Update available");
  });

  it("lands a deep link to Git › In use on its card", async () => {
    window.location.hash = "#settings?page=git&sub=runtime";
    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(card("In use"));
    expect(navChild("In use").getAttribute("aria-current")).toBe("page");
  });
});
