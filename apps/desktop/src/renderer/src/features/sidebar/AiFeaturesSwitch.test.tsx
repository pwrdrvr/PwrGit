// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  err,
  ok,
  type AiProviderSettings,
  type AiProviderSettingsPatch,
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

import { AiFeaturesSwitch } from "./AiFeaturesSwitch";

/**
 * The AI switch at the bottom of the sidebar. What these pin: it is off until
 * someone turns it on, turning it on the first time goes through the
 * disclosure, nothing is probed until it is clicked, and a provider that
 * cannot run sends the reader to set it up rather than switching on something
 * that would only fail later.
 */
let container: HTMLDivElement;
let root: Root;
let settings: AiProviderSettings;
let codex: CodexProviderDiscovery;

const WORK: Profile = {
  id: "work",
  name: "Work",
  email: "me@example.com",
  mono: "W",
  roots: [],
  onboardingCompleted: true
};

async function answer(name: string, request?: unknown): Promise<unknown> {
  if (name === "aiProviders:read") return ok({ profileId: WORK.id, settings });
  if (name === "aiProviders:update") {
    const patch = (request as { patch: AiProviderSettingsPatch }).patch;
    const consentAcceptedAt = patch.consentAcceptedAt ?? settings.consentAcceptedAt;
    settings = {
      ...settings,
      consentAcceptedAt,
      enabled: (patch.enabled ?? settings.enabled) && consentAcceptedAt !== null
    };
    return ok({ profileId: WORK.id, settings });
  }
  if (name === "aiProviders:discoverCodex") return ok(codex);
  if (name === "aiProviders:discoverAcp") return ok({ agents: [] });
  return ok(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  settings = DEFAULT_AI_PROVIDER_SETTINGS;
  codex = {
    candidates: [],
    resolvedPath: "/opt/homebrew/bin/codex",
    auth: {
      status: "authenticated",
      profile: "",
      profileLabel: "System default",
      codexHome: "/Users/you/.codex"
    },
    refreshedAt: "2026-09-19T00:00:00.000Z"
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
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<AiFeaturesSwitch profile={WORK} />);
  });
}

function aiSwitch(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    "button[role='switch'][aria-label='AI features for Work']"
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

function calls(name: string): unknown[] {
  return mocks.dispatch.mock.calls.filter(([called]) => called === name).map(([, req]) => req);
}

describe("AiFeaturesSwitch", () => {
  it("is off by default, and probes nothing just by being on screen", async () => {
    await render();

    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
    expect(aiSwitch().disabled).toBe(false);
    expect(calls("aiProviders:discoverCodex")).toEqual([]);
    expect(calls("aiProviders:discoverAcp")).toEqual([]);
  });

  it("cannot be flipped before the profile's settings have been read", async () => {
    mocks.dispatch.mockImplementation((name: string, request?: unknown) =>
      name === "aiProviders:read" ? new Promise(() => {}) : answer(name, request)
    );
    await render();

    expect(aiSwitch().disabled).toBe(true);
  });

  it("asks main whether Codex can run, then shows the disclosure the first time", async () => {
    await render();

    await click(aiSwitch());

    expect(calls("aiProviders:discoverCodex")).toEqual([{ profileId: "work" }]);
    // History editing refuses ACP, so the agents are not asked about.
    expect(calls("aiProviders:discoverAcp")).toEqual([]);
    expect(consentDialog()?.textContent).toContain("Turn on AI features for Work?");
    expect(calls("aiProviders:update")).toEqual([]);
  });

  it("turns on, recording the acceptance, when the disclosure is accepted", async () => {
    await render();

    await click(aiSwitch());
    await click(button(consentDialog() as HTMLElement, "Turn on AI features"));

    expect(consentDialog()).toBeNull();
    const [request] = calls("aiProviders:update") as { patch: AiProviderSettingsPatch }[];
    expect(request?.patch.enabled).toBe(true);
    expect(Number.isFinite(Date.parse(request?.patch.consentAcceptedAt ?? ""))).toBe(true);
    expect(aiSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("stays off when the disclosure is cancelled", async () => {
    await render();

    await click(aiSwitch());
    await click(button(consentDialog() as HTMLElement, "Cancel"));

    expect(consentDialog()).toBeNull();
    expect(calls("aiProviders:update")).toEqual([]);
    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("sends the reader to AI Providers when Codex cannot run, and switches nothing on", async () => {
    codex = { ...codex, resolvedPath: null, auth: null };
    await render();

    await click(aiSwitch());

    expect(consentDialog()).toBeNull();
    expect(calls("settings:open")).toEqual([
      { page: "ai-providers", profileId: "work", sub: "codex" }
    ]);
    expect(calls("aiProviders:update")).toEqual([]);
    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("turns straight back on once the disclosure was accepted, and off without asking anything", async () => {
    settings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      enabled: true,
      consentAcceptedAt: "2026-09-01T12:00:00.000Z"
    };
    await render();
    expect(aiSwitch().getAttribute("aria-checked")).toBe("true");

    await click(aiSwitch());
    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
    // Off never needs a provider.
    expect(calls("aiProviders:discoverCodex")).toEqual([]);

    await click(aiSwitch());
    expect(consentDialog()).toBeNull();
    expect(aiSwitch().getAttribute("aria-checked")).toBe("true");
    expect(
      (calls("aiProviders:update") as { patch: AiProviderSettingsPatch }[]).map((r) => r.patch)
    ).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it("follows a change made elsewhere — Settings, or another window — for its own profile only", async () => {
    let push: ((snapshot: { profileId: string; settings: AiProviderSettings }) => void) | undefined;
    mocks.subscribe.mockImplementation((_event: string, listener: typeof push) => {
      push = listener;
      return () => {};
    });
    await render();

    const on = { ...DEFAULT_AI_PROVIDER_SETTINGS, enabled: true, consentAcceptedAt: "2026-09-01T12:00:00.000Z" };
    await act(async () => push?.({ profileId: "personal", settings: on }));
    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");

    await act(async () => push?.({ profileId: "work", settings: on }));
    expect(aiSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("says why when the write is refused", async () => {
    settings = { ...DEFAULT_AI_PROVIDER_SETTINGS, consentAcceptedAt: "2026-09-01T12:00:00.000Z" };
    mocks.dispatch.mockImplementation((name: string, request?: unknown) =>
      name === "aiProviders:update"
        ? Promise.resolve(err({ kind: "io", message: "The settings could not be saved." }))
        : answer(name, request)
    );
    await render();

    await click(aiSwitch());

    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "The settings could not be saved."
    );
    expect(aiSwitch().getAttribute("aria-checked")).toBe("false");
  });
});
