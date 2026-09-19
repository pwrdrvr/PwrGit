import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  type AiProviderSettings,
  type CodexProviderDiscovery
} from "@pwrgit/shared";
import { aiJobProviders, firstUnreadyAiProvider, resolveAiToggleAction } from "./ai-enablement";

const ACCEPTED = "2026-09-01T12:00:00.000Z";

function codex(overrides: Partial<CodexProviderDiscovery> = {}): CodexProviderDiscovery {
  return {
    candidates: [],
    resolvedPath: "/opt/homebrew/bin/codex",
    auth: {
      status: "authenticated",
      profile: "",
      profileLabel: "System default",
      codexHome: "/Users/you/.codex"
    },
    refreshedAt: "2026-09-19T00:00:00.000Z",
    ...overrides
  };
}

describe("resolveAiToggleAction", () => {
  it("turns off whatever else is true", () => {
    for (const providerReady of [true, false, undefined]) {
      for (const consentAcceptedAt of [ACCEPTED, null]) {
        expect(resolveAiToggleAction({ enabled: true, consentAcceptedAt, providerReady })).toBe(
          "disable"
        );
      }
    }
  });

  it("sends a provider that cannot run to AI Providers, before the disclosure", () => {
    expect(
      resolveAiToggleAction({ enabled: false, consentAcceptedAt: null, providerReady: false })
    ).toBe("configure");
    expect(
      resolveAiToggleAction({ enabled: false, consentAcceptedAt: ACCEPTED, providerReady: false })
    ).toBe("configure");
  });

  it("shows the disclosure the first time, and only the first time", () => {
    expect(
      resolveAiToggleAction({ enabled: false, consentAcceptedAt: null, providerReady: true })
    ).toBe("consent");
    expect(
      resolveAiToggleAction({ enabled: false, consentAcceptedAt: ACCEPTED, providerReady: true })
    ).toBe("enable");
  });

  it("does not block on a readiness it does not know", () => {
    expect(
      resolveAiToggleAction({ enabled: false, consentAcceptedAt: null, providerReady: undefined })
    ).toBe("consent");
    expect(
      resolveAiToggleAction({ enabled: false, consentAcceptedAt: ACCEPTED, providerReady: undefined })
    ).toBe("enable");
  });
});

describe("firstUnreadyAiProvider", () => {
  const settings: AiProviderSettings = DEFAULT_AI_PROVIDER_SETTINGS;

  it("asks only about Codex while rebase review is the one feature", () => {
    // Rebase review refuses ACP, so a stored agent choice does not count.
    expect(
      aiJobProviders({ ...settings, jobs: { rebaseReview: { provider: "grok" } } })
    ).toEqual(["codex"]);
  });

  it("is null when Codex resolved and is signed in", () => {
    expect(firstUnreadyAiProvider(settings, codex(), null)).toBeNull();
  });

  it("names Codex when no binary resolved", () => {
    expect(firstUnreadyAiProvider(settings, codex({ resolvedPath: null, auth: null }), null)).toBe(
      "codex"
    );
  });

  it("names Codex when it is known to be signed out", () => {
    const signedOut = codex();
    if (signedOut.auth !== null) signedOut.auth.status = "unauthenticated";
    expect(firstUnreadyAiProvider(settings, signedOut, null)).toBe("codex");
  });

  it("does not treat a sign-in check that failed as signed out", () => {
    const unknown = codex();
    if (unknown.auth !== null) unknown.auth.status = "failed";
    expect(firstUnreadyAiProvider(settings, unknown, null)).toBeNull();
  });

  it("is undefined while Codex has not answered", () => {
    expect(firstUnreadyAiProvider(settings, null, null)).toBeUndefined();
  });
});
