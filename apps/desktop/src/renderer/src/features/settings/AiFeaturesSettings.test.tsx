// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  ok,
  type AiProviderSettings,
  type CodexModelOption,
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

import { AiFeaturesSettings } from "./AiFeaturesSettings";
import { AiProvidersProvider } from "./AiProvidersContext";
import { __resetCollapsedPanesForTests } from "./SettingsLayout";

/**
 * Settings → AI Features: what each feature runs on, and the guidance it
 * carries.
 *
 * The rule most of these pin is "the value stored is the value shown is the
 * value that runs": a provider the job cannot use is never offered, a model
 * from another backend does not linger, and an effort the chosen model does
 * not take is not sent.
 */
let container: HTMLDivElement;
let root: Root;
let settings: AiProviderSettings;
let models: CodexModelOption[];

const PERSONAL: Profile = {
  id: "personal",
  name: "Personal",
  email: "me@example.com",
  mono: "P",
  roots: [],
  onboardingCompleted: true
};

function model(overrides: Partial<CodexModelOption> & { id: string }): CodexModelOption {
  return {
    model: overrides.id,
    displayName: overrides.id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    isDefault: false,
    ...overrides
  };
}

async function answer(name: string): Promise<unknown> {
  if (name === "aiProviders:read" || name === "aiProviders:update") {
    return ok({ profileId: PERSONAL.id, settings });
  }
  if (name === "aiProviders:discoverCodex") {
    return ok({
      candidates: [{ path: "/opt/homebrew/bin/codex", source: "path", version: "0.201.0", available: true }],
      resolvedPath: "/opt/homebrew/bin/codex",
      auth: {
        status: "authenticated",
        profile: "",
        profileLabel: "System default",
        codexHome: "/Users/you/.codex"
      },
      refreshedAt: "2026-09-19T00:00:00.000Z"
    });
  }
  if (name === "aiProviders:discoverAcp") return ok({ agents: [] });
  if (name === "aiProviders:codexModels") return ok({ models });
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
  models = [
    model({ id: "gpt-luna", displayName: "GPT Luna", isDefault: true }),
    model({ id: "gpt-mini", displayName: "GPT Mini", supportedReasoningEfforts: ["low", "medium"] }),
    model({ id: "gpt-internal", displayName: "Internal", hidden: true })
  ];
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
        <AiFeaturesSettings profile={{ profiles: [PERSONAL], value: PERSONAL.id, onChange: () => {} }} />
      </AiProvidersProvider>
    );
  });
}

function select(label: string): HTMLSelectElement {
  const found = container.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`);
  if (found === null) throw new Error(`no select "${label}"`);
  return found;
}

function options(element: HTMLSelectElement): string[] {
  return [...element.options].map((option) => option.textContent?.trim() ?? "");
}

async function choose(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function updates(): unknown[] {
  return mocks.dispatch.mock.calls
    .filter(([name]) => name === "aiProviders:update")
    .map(([, req]) => (req as { patch: unknown }).patch);
}

describe("AI Features — default agents", () => {
  it("offers only Codex for rebase review, and says why", async () => {
    // Grok is enabled, and would be offered for a job that accepts ACP.
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, acp: { enabledAgentIds: ["grok"], agents: {} } };
    await render();

    const provider = select("Rebase review provider");
    expect(options(provider)).toEqual(["Codex"]);
    expect(provider.disabled).toBe(true);
    expect(container.textContent).toContain("no-tools boundary");
  });

  it("shows the provider that runs, not a stored agent the job refuses", async () => {
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["grok"], agents: {} },
      jobs: { rebaseReview: { provider: "grok" } }
    };
    await render();

    expect(select("Rebase review provider").value).toBe("codex");
  });

  it("lists Codex's visible models and names what Default means", async () => {
    await render();

    expect(options(select("Rebase review model"))).toEqual([
      "Default (GPT Luna)",
      "GPT Luna",
      "GPT Mini"
    ]);
    expect(options(select("Rebase review reasoning effort"))).toEqual([
      "Default (medium)",
      "low",
      "medium",
      "high"
    ]);
  });

  it("clears an effort the newly chosen model does not take", async () => {
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: { rebaseReview: { reasoning: "high" } } };
    await render();

    await choose(select("Rebase review model"), "gpt-mini");

    expect(updates()).toEqual([{ jobs: { rebaseReview: { model: "gpt-mini", reasoning: "" } } }]);
  });

  it("clears a stored model the running provider does not offer, once", async () => {
    // Left behind by another provider: shown as Default, and still sent every
    // run until it is cleared.
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: { rebaseReview: { model: "grok-build" } } };
    await render();

    expect(select("Rebase review model").value).toBe("");
    expect(updates()).toEqual([{ jobs: { rebaseReview: { model: "" } } }]);
  });

  it("leaves a stored model alone while Codex's list is unavailable", async () => {
    // An empty list may be a failed read, not proof the model is gone.
    models = [];
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: { rebaseReview: { model: "gpt-luna" } } };
    await render();

    expect(updates()).toEqual([]);
  });
});

describe("AI Features — guidance", () => {
  it("saves on leaving the field, not on every keystroke", async () => {
    await render();
    const field = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Guidance for every AI feature']"
    );
    if (field === null) throw new Error("no guidance field");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        field,
        "Keep it short."
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(updates()).toEqual([]);

    await act(async () => {
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(updates()).toEqual([{ guidance: "Keep it short." }]);
  });
});
