// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  ok,
  type AiProviderSettings,
  type AiProviderSettingsPatch,
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

async function answer(name: string, request?: unknown): Promise<unknown> {
  if (name === "aiProviders:update") {
    // The switch fields only, applied as main applies them: on needs consent.
    const patch = (request as { patch: AiProviderSettingsPatch }).patch;
    const consentAcceptedAt = patch.consentAcceptedAt ?? settings.consentAcceptedAt;
    settings = {
      ...settings,
      consentAcceptedAt,
      enabled: (patch.enabled ?? settings.enabled) && consentAcceptedAt !== null
    };
    return ok({ profileId: PERSONAL.id, settings });
  }
  if (name === "aiProviders:read") return ok({ profileId: PERSONAL.id, settings });
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

function aiSwitch(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    "button[role='switch'][aria-label='Use AI features for Personal']"
  );
  if (found === null) throw new Error("no AI switch");
  return found;
}

function consentDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ai-consent[role='dialog']");
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe("AI Features — availability", () => {
  it("is off for a profile that never turned it on", async () => {
    await render();

    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("[aria-label='AI features: Off']")).not.toBeNull();
    // The first card is the switch: it is what every other card waits on.
    expect(container.querySelector(".settings-panel__title")?.textContent).toBe("Availability");
  });

  it("shows the disclosure before the first switch-on, and writes nothing if it is cancelled", async () => {
    await render();

    await click(aiSwitch());
    const dialog = consentDialog();
    expect(dialog?.textContent).toContain("Turn on AI features for Personal?");
    // Cancel holds focus, so Enter on an unread dialog does not accept it.
    expect(document.activeElement?.textContent).toBe("Cancel");

    await click(button(dialog as HTMLElement, "Cancel"));
    expect(consentDialog()).toBeNull();
    expect(updates()).toEqual([]);
    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("records the acceptance with the switch-on", async () => {
    await render();

    await click(aiSwitch());
    await click(button(consentDialog() as HTMLElement, "Turn on AI features"));

    expect(consentDialog()).toBeNull();
    const [patch] = updates() as AiProviderSettingsPatch[];
    expect(patch?.enabled).toBe(true);
    expect(Number.isFinite(Date.parse(patch?.consentAcceptedAt ?? ""))).toBe(true);
    expect(aiSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("does not ask twice: once accepted, on and off are just writes", async () => {
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, consentAcceptedAt: "2026-09-01T12:00:00.000Z" };
    await render();

    await click(aiSwitch());
    expect(consentDialog()).toBeNull();
    expect(aiSwitch().getAttribute("aria-checked")).toBe("true");

    await click(aiSwitch());
    expect(updates()).toEqual([{ enabled: true }, { enabled: false }]);
    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
  });
});

describe("AI Features — default agents", () => {
  it("offers only Codex for history editing, and says why", async () => {
    // Grok is enabled, and would be offered for a job that accepts ACP.
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, acp: { enabledAgentIds: ["grok"], agents: {} } };
    await render();

    const provider = select("History editing provider");
    expect(options(provider)).toEqual(["Codex"]);
    expect(provider.disabled).toBe(true);
    expect(container.textContent).toContain("no-tools boundary");
  });

  it("shows the provider that runs, not a stored agent the job refuses", async () => {
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["grok"], agents: {} },
      jobs: { ...DEFAULT_AI_PROVIDER_SETTINGS.jobs, historyEditing: { provider: "grok" } }
    };
    await render();

    expect(select("History editing provider").value).toBe("codex");
  });

  it("lists Codex's visible models and names what Default means", async () => {
    await render();

    expect(options(select("History editing model"))).toEqual([
      "Default (GPT Luna)",
      "GPT Luna",
      "GPT Mini"
    ]);
    expect(options(select("History editing reasoning effort"))).toEqual([
      "Default (medium)",
      "low",
      "medium",
      "high"
    ]);
  });

  it("clears an effort the newly chosen model does not take", async () => {
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: { ...DEFAULT_AI_PROVIDER_SETTINGS.jobs, historyEditing: { reasoning: "high" } } };
    await render();

    await choose(select("History editing model"), "gpt-mini");

    expect(updates()).toEqual([{ jobs: { historyEditing: { model: "gpt-mini", reasoning: "" } } }]);
  });

  it("clears a stored model the running provider does not offer, once", async () => {
    // Left behind by another provider: shown as Default, and still sent every
    // run until it is cleared.
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: { ...DEFAULT_AI_PROVIDER_SETTINGS.jobs, historyEditing: { model: "grok-build" } } };
    await render();

    expect(select("History editing model").value).toBe("");
    expect(updates()).toEqual([{ jobs: { historyEditing: { model: "" } } }]);
  });

  it("leaves a stored model alone while Codex's list is unavailable", async () => {
    // An empty list may be a failed read, not proof the model is gone.
    models = [];
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: { ...DEFAULT_AI_PROVIDER_SETTINGS.jobs, historyEditing: { model: "gpt-luna" } } };
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
