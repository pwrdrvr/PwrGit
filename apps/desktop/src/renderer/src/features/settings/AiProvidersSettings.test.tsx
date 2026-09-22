// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  err,
  ok,
  type AcpAgentDiscovery,
  type AiProviderSettings,
  type CodexProviderDiscovery,
  type Profile
} from "@pwrgit/shared";

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

import { AiProvidersProvider } from "./AiProvidersContext";
import { AiProvidersSettings } from "./AiProvidersSettings";
import { __resetCollapsedPanesForTests } from "./SettingsLayout";

/**
 * Settings → AI Providers, one card per provider.
 *
 * What these pin is the part a reader acts on: which binary a job will run,
 * which account it signs in as, and that an agent can only be switched on
 * once there is something to switch on. Every write is asserted as the patch
 * main receives, because that patch is the whole contract with the service.
 */
let container: HTMLDivElement;
let root: Root;
let settings: AiProviderSettings;
let codex: CodexProviderDiscovery;
let acp: AcpAgentDiscovery;

const PERSONAL: Profile = {
  id: "personal",
  name: "Personal",
  email: "me@example.com",
  mono: "P",
  roots: [],
  onboardingCompleted: true
};

async function answer(name: string, req?: unknown): Promise<unknown> {
  if (name === "aiProviders:read" || name === "aiProviders:update") {
    return ok({ profileId: PERSONAL.id, settings });
  }
  if (name === "aiProviders:discoverCodex") return ok(codex);
  if (name === "aiProviders:discoverAcp") return ok(acp);
  if (name === "aiProviders:codexAuthProfiles") {
    return ok({
      profiles: [
        {
          name: "",
          displayName: "System default",
          codexHome: "/Users/you/.codex",
          hasAuthFile: true,
          email: "dev@example.com"
        },
        { name: "work", displayName: "work", codexHome: "/Users/you/.codex/profiles/work", hasAuthFile: false }
      ],
      followed: ""
    });
  }
  if (name === "aiProviders:acpModels") {
    const agentId = (req as { agentId: string }).agentId;
    return ok({ agentId, models: [{ id: "grok-build", label: "Grok Build", isDefault: true }] });
  }
  return ok(undefined);
}

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
  __resetCollapsedPanesForTests();
  installBridge();
  vi.clearAllMocks();
  settings = DEFAULT_AI_PROVIDER_SETTINGS;
  codex = {
    candidates: [
      { path: "/opt/homebrew/bin/codex", source: "path", version: "0.201.0", available: true },
      { path: "/Applications/Codex.app/Contents/Resources/codex", source: "application", version: "0.200.0", available: true },
      { path: "/usr/local/bin/codex", source: "path", version: "0.90.0", available: false, failureReason: "too old" }
    ],
    resolvedPath: "/opt/homebrew/bin/codex",
    auth: {
      status: "authenticated",
      profile: "",
      profileLabel: "System default",
      codexHome: "/Users/you/.codex",
      email: "dev@example.com"
    },
    refreshedAt: "2026-09-19T00:00:00.000Z"
  };
  acp = {
    agents: [
      {
        id: "grok",
        displayName: "Grok",
        installed: true,
        version: "1.2.0",
        instances: [
          { command: "/usr/local/bin/grok", version: "1.2.0", source: "path" },
          { command: "/Users/you/.local/bin/grok", version: "1.1.0", source: "fallback" }
        ],
        activeCommand: "/usr/local/bin/grok"
      },
      { id: "kimi", displayName: "Kimi Code CLI", installed: false, detail: "Install Kimi Code CLI", instances: [] },
      { id: "qwen", displayName: "Qwen Code", installed: false, detail: "Install Qwen Code", instances: [] }
    ]
  };
  mocks.subscribe.mockReturnValue(() => {});
  mocks.dispatch.mockImplementation(answer);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "pwrgit");
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <AiProvidersProvider profileId={PERSONAL.id}>
        <AiProvidersSettings
          profile={{ profiles: [PERSONAL], value: PERSONAL.id, onChange: () => {} }}
          onEditDefaults={() => {}}
        />
      </AiProvidersProvider>
    );
  });
}

/** One provider's card: the section element, found by its title. */
function card(title: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`section[aria-label='${title}']`);
  if (found === null) throw new Error(`no card for ${title}`);
  return found;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

async function type(element: HTMLInputElement, next: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, next);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function updates(): unknown[] {
  return mocks.dispatch.mock.calls
    .filter(([name]) => name === "aiProviders:update")
    .map(([, req]) => (req as { patch: unknown }).patch);
}

describe("AI Providers pane", () => {
  it("has a card per provider, and none for Gemini", async () => {
    await render();

    const titles = [...container.querySelectorAll(".settings-panel__title")].map((node) =>
      node.textContent?.trim()
    );
    expect(titles).toEqual(["Codex", "Grok", "Kimi Code CLI", "Qwen Code"]);
    expect(container.textContent).not.toMatch(/gemini/i);
  });

  it("marks the binary that runs, and pins another on Use", async () => {
    await render();
    const codexCard = card("Codex");
    const using = codexCard.querySelector(".settings-ai-install.is-using");
    expect(using?.textContent).toContain("/opt/homebrew/bin/codex");

    await act(async () =>
      button(codexCard, "Use /Applications/Codex.app/Contents/Resources/codex").click()
    );

    expect(updates()).toEqual([
      {
        codex: { mode: "pinned", pinnedPath: "/Applications/Codex.app/Contents/Resources/codex" }
      }
    ]);
    // A binary that failed its probe is not something to pin.
    expect(button(codexCard, "Use /usr/local/bin/codex").disabled).toBe(true);
  });

  it("refuses a relative custom path before anything is sent", async () => {
    // Main drops a relative path too, but silently; the pane is where the
    // reader can be told why.
    await render();
    const input = container.querySelector<HTMLInputElement>("input[aria-label='Custom Codex path']");
    if (input === null) throw new Error("no custom path field");
    await type(input, "bin/codex");
    await act(async () => button(card("Codex"), "Use path").click());

    expect(updates()).toEqual([]);
    expect(card("Codex").textContent).toContain("absolute executable path");
  });

  it("switches the account back to following the profile with null, not an empty name", async () => {
    // "" pins the System default; only `null` means follow.
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, codex: { mode: "auto", pinnedPath: "", authProfile: "work" } };
    await render();
    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Codex account']");
    if (select === null) throw new Error("no account select");
    expect(select.value).toBe("work");

    await choose(select, ":follow");

    expect(updates()).toEqual([{ codex: { authProfile: null } }]);
  });

  it("starts a sign-in and says where to finish it", async () => {
    codex = {
      ...codex,
      auth: { status: "unauthenticated", profile: "", profileLabel: "System default", codexHome: "/Users/you/.codex" }
    };
    mocks.dispatch.mockImplementation(async (name: string, req: unknown) =>
      name === "aiProviders:codexLogin"
        ? ok({ profile: "", started: true })
        : answer(name, req)
    );
    await render();
    expect(card("Codex").textContent).toContain("Not signed in (System default)");

    await act(async () => button(card("Codex"), "Sign in…").click());

    expect(mocks.dispatch).toHaveBeenCalledWith("aiProviders:codexLogin", { profileId: PERSONAL.id });
    expect(card("Codex").textContent).toContain("Finish signing in in your browser");
  });

  it("only lets an agent be enabled once there is an install", async () => {
    await render();
    const kimi = card("Kimi Code CLI").querySelector<HTMLButtonElement>("[role='switch']");
    expect(kimi?.disabled).toBe(true);
    expect(card("Kimi Code CLI").textContent).toContain("Install Kimi Code CLI");

    const grok = card("Grok").querySelector<HTMLButtonElement>("[role='switch']");
    await act(async () => grok?.click());

    expect(updates()).toEqual([{ acp: { enabledAgentIds: ["grok"] } }]);
  });

  it("pins an install with Use, and offers nothing on one in use by default", async () => {
    // The first install found runs until something else is chosen. There is
    // nothing to unpin on it, and an "Unpin" there would promise a change
    // that clicking cannot make.
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["grok"], agents: {} }
    };
    await render();
    const active = card("Grok").querySelector(".settings-ai-install.is-using");
    expect(active?.querySelector("button")).toBeNull();

    await act(async () => button(card("Grok"), "Use /Users/you/.local/bin/grok").click());

    expect(updates()).toEqual([
      { acp: { agents: { grok: { selectedPath: "/Users/you/.local/bin/grok" } } } }
    ]);
  });

  it("unpins a pinned install back to the first found", async () => {
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: {
        enabledAgentIds: ["grok"],
        agents: { grok: { selectedPath: "/Users/you/.local/bin/grok" } }
      }
    };
    const [grok] = acp.agents;
    if (grok !== undefined) grok.activeCommand = "/Users/you/.local/bin/grok";
    await render();

    await act(async () => button(card("Grok"), "Stop pinning /Users/you/.local/bin/grok").click());

    expect(updates()).toEqual([{ acp: { agents: { grok: { selectedPath: "" } } } }]);
  });

  it("says why an agent is not the default for a Codex-only feature", async () => {
    // Otherwise an enabled agent that no feature lists looks forgotten.
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["grok"], agents: {} },
      jobs: { ...DEFAULT_AI_PROVIDER_SETTINGS.jobs, historyEditing: { provider: "grok" } }
    };
    await render();

    expect(card("Codex").textContent).toContain("History editing");
    expect(card("Grok").textContent).toContain("No feature");
    expect(card("Grok").textContent).toContain("no-tools boundary");
  });

  it("checks an enabled agent's session and reports what it offered", async () => {
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["grok"], agents: {} }
    };
    await render();
    await act(async () => button(card("Grok"), "Check session").click());

    expect(mocks.dispatch).toHaveBeenCalledWith("aiProviders:acpModels", {
      profileId: PERSONAL.id,
      agentId: "grok",
      refresh: true
    });
    expect(card("Grok").textContent).toContain("1 model offered");
  });

  it("turns a failed session check into the card's state", async () => {
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["grok"], agents: {} }
    };
    mocks.dispatch.mockImplementation(async (name: string, req: unknown) =>
      name === "aiProviders:acpModels"
        ? err({ kind: "agent", code: "acp_models_failed", message: "Grok is not signed in." })
        : answer(name, req)
    );
    await render();
    await act(async () => button(card("Grok"), "Check session").click());

    expect(card("Grok").textContent).toContain("Unavailable");
    expect(card("Grok").textContent).toContain("Grok is not signed in.");
  });
});
