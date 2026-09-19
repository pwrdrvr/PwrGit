import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  type AcpAgentDiscovery,
  type AcpAgentDiscoveryEntry,
  type AiProviderSettings,
  type BuiltInAcpAgentId,
  type CodexProviderDiscovery
} from "@pwrgit/shared";
import {
  aiProviderChipTone,
  describeAcpAgentStatus,
  describeAiProviders,
  describeCodexStatus,
  enabledAcpAgentIdsForModelProbes,
  routedJobs,
  type AiProviderStatus,
  type AiProviderStatusInput
} from "./ai-provider-status";

const CODEX_PATH = "/opt/homebrew/bin/codex";

/** A discovery shaped the way main's reports one: `resolvedPath` names one of
 *  the candidates, and `auth` is present exactly when something resolved. */
function codex(overrides: Partial<CodexProviderDiscovery> = {}): CodexProviderDiscovery {
  return {
    candidates: [{ path: CODEX_PATH, source: "path", version: "0.40.0", available: true }],
    resolvedPath: CODEX_PATH,
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

function agent(
  id: BuiltInAcpAgentId,
  overrides: Partial<AcpAgentDiscoveryEntry> = {}
): AcpAgentDiscoveryEntry {
  const installed = overrides.installed ?? true;
  return {
    id,
    displayName: `${id} (kit)`,
    installed,
    ...(installed
      ? { version: "1.2.3", activeCommand: `/usr/local/bin/${id}` }
      : { detail: `npm i -g ${id}` }),
    instances: installed
      ? [{ command: `/usr/local/bin/${id}`, version: "1.2.3", source: "path" }]
      : [],
    ...overrides
  };
}

function settings(
  jobs: AiProviderSettings["jobs"],
  enabledAgentIds: BuiltInAcpAgentId[]
): AiProviderSettings {
  return { ...DEFAULT_AI_PROVIDER_SETTINGS, acp: { enabledAgentIds, agents: {} }, jobs };
}

describe("describeCodexStatus", () => {
  it("reports no tone before discovery answers, since any dot would be a guess", () => {
    const checking = describeCodexStatus(null, true);
    expect(checking.tone).toBeUndefined();
    expect(checking.chip).toBeUndefined();
    expect(checking.badge).toBe("Checking…");
    expect(describeCodexStatus(null, false).badge).toBe("Unknown");
    expect(describeCodexStatus(null, false).tone).toBeUndefined();
  });

  it("calls Codex missing when nothing resolved", () => {
    const status = describeCodexStatus(codex({ resolvedPath: null, auth: null }), false);
    expect(status).toMatchObject({ tone: "bad", chip: "missing", badge: "Not found" });
  });

  it("asks for a sign-in when the binary is there but signed out", () => {
    const status = describeCodexStatus(
      codex({
        auth: {
          status: "unauthenticated",
          profile: "",
          profileLabel: "System default",
          codexHome: "/Users/you/.codex"
        }
      }),
      false
    );
    // The chip is the remedy, because the nav row is where the reader decides
    // what to do next.
    expect(status).toMatchObject({ tone: "warn", chip: "sign in", badge: "Sign in" });
  });

  it("warns when the sign-in check itself failed", () => {
    const status = describeCodexStatus(
      codex({
        auth: {
          status: "failed",
          profile: "work",
          profileLabel: "work",
          codexHome: "/Users/you/.codex/profiles/work"
        }
      }),
      false
    );
    expect(status).toMatchObject({ tone: "warn", chip: "check" });
  });

  it("reads Ready with no chip, and names the version and path that will run", () => {
    const status = describeCodexStatus(codex(), false);
    expect(status).toMatchObject({ tone: "ok", badge: "Ready", meta: `v0.40.0 · ${CODEX_PATH}` });
    expect(status.chip).toBeUndefined();
  });

  it("takes the version from the resolved candidate, not the first one found", () => {
    const status = describeCodexStatus(
      codex({
        candidates: [
          { path: "/usr/local/bin/codex", source: "path", version: "9.9.9", available: false },
          { path: CODEX_PATH, source: "application", version: "0.40.0", available: true }
        ]
      }),
      false
    );
    expect(status.meta).toBe(`v0.40.0 · ${CODEX_PATH}`);
  });

  it("shows just the path when the resolved binary reported no version", () => {
    const status = describeCodexStatus(
      codex({ candidates: [{ path: CODEX_PATH, source: "path", version: null, available: true }] }),
      false
    );
    expect(status.meta).toBe(CODEX_PATH);
  });
});

describe("describeAcpAgentStatus", () => {
  it("says an installed agent that is not enabled is off — a choice, not a fault", () => {
    const status = describeAcpAgentStatus("grok", agent("grok"), false, false, undefined);
    expect(status).toMatchObject({
      tone: "off",
      chip: "off",
      badge: "Off",
      meta: "v1.2.3 · /usr/local/bin/grok"
    });
  });

  it("splits a disabled agent's word when there is nothing installed to enable", () => {
    // Grey either way, but a fresh install would otherwise paint every agent
    // the same and hide whether the CLI is even there.
    const status = describeAcpAgentStatus(
      "kimi",
      agent("kimi", { installed: false }),
      false,
      false,
      undefined
    );
    expect(status).toMatchObject({
      tone: "off",
      chip: "missing",
      badge: "Not installed",
      meta: "npm i -g kimi"
    });
  });

  it("calls an enabled agent that is not installed bad", () => {
    const status = describeAcpAgentStatus(
      "qwen",
      agent("qwen", { installed: false }),
      false,
      true,
      "spawn ENOENT"
    );
    // Missing outranks a model error: there is nothing to have probed.
    expect(status).toMatchObject({ tone: "bad", chip: "missing", badge: "Not installed" });
  });

  it("warns on an enabled agent whose model probe failed, and shows the error", () => {
    const status = describeAcpAgentStatus("grok", agent("grok"), false, true, "not signed in");
    expect(status).toMatchObject({
      tone: "warn",
      chip: "error",
      badge: "Unavailable",
      meta: "not signed in"
    });
  });

  it("does not paint a disabled agent with a probe error it still carries", () => {
    const status = describeAcpAgentStatus("grok", agent("grok"), false, false, "not signed in");
    expect(status).toMatchObject({ tone: "off", chip: "off" });
  });

  it("reads an enabled, installed agent as Enabled with no chip", () => {
    const status = describeAcpAgentStatus("grok", agent("grok"), false, true, undefined);
    expect(status).toMatchObject({
      tone: "ok",
      badge: "Enabled",
      meta: "v1.2.3 · /usr/local/bin/grok"
    });
    expect(status.chip).toBeUndefined();
  });

  it("says Installed when the probe passed but reported no version or command", () => {
    const entry: AcpAgentDiscoveryEntry = {
      id: "grok",
      displayName: "Grok",
      installed: true,
      instances: []
    };
    expect(describeAcpAgentStatus("grok", entry, false, true, undefined).meta).toBe("Installed");
  });

  it("falls back to Not installed when a missing agent carries no install hint", () => {
    const entry: AcpAgentDiscoveryEntry = {
      id: "qwen",
      displayName: "Qwen Code",
      installed: false,
      instances: []
    };
    expect(describeAcpAgentStatus("qwen", entry, false, false, undefined).meta).toBe(
      "Not installed"
    );
  });

  it("labels from discovery once it answers, and from settings until then", () => {
    expect(describeAcpAgentStatus("kimi", agent("kimi"), false, true, undefined).label).toBe(
      "kimi (kit)"
    );
    expect(describeAcpAgentStatus("kimi", undefined, true, true, undefined).label).toBe(
      "Kimi Code CLI"
    );
  });

  it("reports an enabled agent discovery has not answered for with no tone", () => {
    const checking = describeAcpAgentStatus("kimi", undefined, true, true, undefined);
    expect(checking.tone).toBeUndefined();
    expect(checking.badge).toBe("Checking…");
    expect(describeAcpAgentStatus("kimi", undefined, false, true, undefined).badge).toBe("Unknown");
  });

  it("calls an agent off before discovery answers when it is not enabled anyway", () => {
    // Whatever discovery finds, a disabled agent's dot is grey.
    expect(describeAcpAgentStatus("kimi", undefined, true, false, undefined)).toMatchObject({
      tone: "off",
      chip: "off",
      badge: "Off"
    });
  });
});

describe("sentence", () => {
  it("is present exactly when there is a tone, and reads label then badge", () => {
    const statuses: AiProviderStatus[] = [
      describeCodexStatus(null, true),
      describeCodexStatus(null, false),
      describeCodexStatus(codex({ resolvedPath: null, auth: null }), false),
      describeCodexStatus(codex(), false),
      describeAcpAgentStatus("grok", undefined, true, true, undefined),
      describeAcpAgentStatus("grok", undefined, false, false, undefined),
      describeAcpAgentStatus("grok", agent("grok"), false, false, undefined),
      describeAcpAgentStatus("grok", agent("grok", { installed: false }), false, true, undefined),
      describeAcpAgentStatus("grok", agent("grok"), false, true, "boom"),
      describeAcpAgentStatus("grok", agent("grok"), false, true, undefined)
    ];
    for (const status of statuses) {
      if (status.tone === undefined) {
        expect(status.sentence, status.badge).toBeUndefined();
      } else {
        expect(status.sentence).toBe(`${status.label}: ${status.badge}`);
      }
    }
  });
});

describe("describeAiProviders", () => {
  function input(overrides: Partial<AiProviderStatusInput> = {}): AiProviderStatusInput {
    return {
      codex: codex(),
      codexLoading: false,
      acpDiscovery: { agents: [agent("grok"), agent("kimi"), agent("qwen", { installed: false })] },
      acpDiscoveryLoading: false,
      enabledAgentIds: [],
      acpModelErrors: {},
      ...overrides
    };
  }

  it("lists Codex, then the ACP agents in display order", () => {
    expect(describeAiProviders(input()).map((status) => status.sub)).toEqual([
      "codex",
      "grok",
      "kimi",
      "qwen"
    ]);
  });

  it("never lists Gemini, even when discovery or settings mention it", () => {
    const withGemini = {
      agents: [
        { id: "gemini", displayName: "Gemini CLI", installed: true, instances: [] },
        agent("grok")
      ]
    } as unknown as AcpAgentDiscovery;
    const statuses = describeAiProviders(
      input({
        acpDiscovery: withGemini,
        enabledAgentIds: ["gemini", "grok"],
        acpModelErrors: { gemini: "boom" }
      })
    );
    expect(statuses.map((status) => status.sub)).toEqual(["codex", "grok", "kimi", "qwen"]);
    expect(statuses.map((status) => status.label)).not.toContain("Gemini CLI");
  });

  it("matches each agent to its own discovery entry, enablement and probe error", () => {
    const [codexStatus, grok, kimi, qwen] = describeAiProviders(
      input({ enabledAgentIds: ["kimi", "qwen"], acpModelErrors: { kimi: "not signed in" } })
    );
    expect(codexStatus?.tone).toBe("ok");
    expect(grok).toMatchObject({ tone: "off", chip: "off" });
    expect(kimi).toMatchObject({ tone: "warn", meta: "not signed in" });
    expect(qwen).toMatchObject({ tone: "bad", chip: "missing" });
  });

  it("passes loading through while nothing has answered", () => {
    const statuses = describeAiProviders(
      input({
        codex: null,
        codexLoading: true,
        acpDiscovery: null,
        acpDiscoveryLoading: true,
        enabledAgentIds: ["grok"]
      })
    );
    expect(statuses[0]?.badge).toBe("Checking…");
    expect(statuses[1]?.badge).toBe("Checking…");
    // Not enabled: off, whatever discovery is doing.
    expect(statuses[2]?.tone).toBe("off");
  });
});

describe("aiProviderChipTone", () => {
  it("maps bad to the card's err and leaves off and unknown neutral", () => {
    expect(aiProviderChipTone("ok")).toBe("ok");
    expect(aiProviderChipTone("warn")).toBe("warn");
    expect(aiProviderChipTone("bad")).toBe("err");
    expect(aiProviderChipTone("off")).toBe("default");
    expect(aiProviderChipTone(undefined)).toBe("default");
  });
});

describe("routedJobs", () => {
  it("has nothing to route before settings load", () => {
    expect(routedJobs(null, "codex")).toEqual([]);
  });

  it("gives Codex every unset job", () => {
    expect(routedJobs(DEFAULT_AI_PROVIDER_SETTINGS, "codex")).toEqual(["rebaseReview"]);
    expect(routedJobs(DEFAULT_AI_PROVIDER_SETTINGS, "grok")).toEqual([]);
  });

  it("keeps a Codex-only job on Codex even when an enabled agent is stored for it", () => {
    // Counting the stored string would leave the Codex card claiming no jobs
    // while the rebase review ran through it.
    const stored = settings({ rebaseReview: { provider: "grok" } }, ["grok"]);
    expect(routedJobs(stored, "codex")).toEqual(["rebaseReview"]);
    expect(routedJobs(stored, "grok")).toEqual([]);
  });
});

describe("enabledAcpAgentIdsForModelProbes", () => {
  it("probes nothing before settings load", () => {
    expect(enabledAcpAgentIdsForModelProbes(null)).toEqual([]);
  });

  it("probes nothing today, since the only job runs on Codex whatever is stored", () => {
    // A probe spawns the agent. Routing a Codex-only job to an enabled agent
    // must not start that agent just to fill a picker the job cannot use.
    expect(
      enabledAcpAgentIdsForModelProbes(
        settings({ rebaseReview: { provider: "grok" } }, ["grok", "kimi", "qwen"])
      )
    ).toEqual([]);
    expect(enabledAcpAgentIdsForModelProbes(DEFAULT_AI_PROVIDER_SETTINGS)).toEqual([]);
  });
});
