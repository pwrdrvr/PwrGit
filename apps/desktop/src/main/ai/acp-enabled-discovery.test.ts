import { BUILT_IN_ACP_STRATEGIES } from "@pwrdrvr/agent-acp";
import {
  AI_JOBS,
  BUILT_IN_ACP_AGENT_IDS,
  DEFAULT_AI_PROVIDER_SETTINGS,
  type AcpAgentPreference,
  type AiProviderSettings,
  type BuiltInAcpAgentId
} from "@pwrgit/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  PWRGIT_ACP_STRATEGIES,
  acpDiscoveryOptionsForEnabledAgent,
  acpDiscoveryOptionsForEnabledAgents,
  acpDiscoveryOptionsForInstallScan,
  enabledAcpAgentIdsInUse,
  pwrgitAcpStrategy
} from "./acp-enabled-discovery";

function settingsWith(input: {
  enabled?: BuiltInAcpAgentId[];
  agents?: Partial<Record<BuiltInAcpAgentId, AcpAgentPreference>>;
  provider?: AiProviderSettings["jobs"]["rebaseReview"]["provider"];
}): AiProviderSettings {
  const settings = structuredClone(DEFAULT_AI_PROVIDER_SETTINGS);
  if (input.enabled !== undefined) settings.acp.enabledAgentIds = input.enabled;
  if (input.agents !== undefined) settings.acp.agents = input.agents;
  if (input.provider !== undefined) settings.jobs.rebaseReview.provider = input.provider;
  return settings;
}

const ids = (strategies: readonly { id: string }[] | undefined): string[] =>
  (strategies ?? []).map((strategy) => strategy.id);

describe("PWRGIT_ACP_STRATEGIES", () => {
  it("offers Grok, Kimi and Qwen in PwrGit's display order, not the kit's", () => {
    expect(ids(PWRGIT_ACP_STRATEGIES)).toEqual(["grok", "kimi", "qwen"]);
  });

  it("never carries Gemini, although the kit still ships a strategy for it", () => {
    // The kit's table is the thing being filtered; if it ever stops shipping
    // Gemini this guard is vacuous and should be revisited, not deleted.
    expect(ids(BUILT_IN_ACP_STRATEGIES)).toContain("gemini");
    expect(ids(PWRGIT_ACP_STRATEGIES)).not.toContain("gemini");
  });
});

describe("pwrgitAcpStrategy", () => {
  it("answers with the kit's own strategy for an offered agent", () => {
    expect(pwrgitAcpStrategy("qwen")).toBe(
      BUILT_IN_ACP_STRATEGIES.find((strategy) => strategy.id === "qwen")
    );
  });

  it("answers undefined for Gemini however the kit answers for it", () => {
    expect(pwrgitAcpStrategy("gemini")).toBeUndefined();
  });

  it("answers undefined for ids that are not ACP agents at all", () => {
    for (const id of ["codex", "", "GROK", "__proto__"]) {
      expect(pwrgitAcpStrategy(id)).toBeUndefined();
    }
  });
});

describe("acpDiscoveryOptionsForEnabledAgents", () => {
  it("probes nothing until an agent is enabled", () => {
    expect(acpDiscoveryOptionsForEnabledAgents(settingsWith({}))).toEqual({ strategies: [] });
  });

  it("probes only the enabled agents", () => {
    const options = acpDiscoveryOptionsForEnabledAgents(settingsWith({ enabled: ["qwen", "grok"] }));
    expect(ids(options.strategies)).toEqual(["grok", "qwen"]);
  });

  it("passes enabled agents' override paths, trimmed, and nobody else's", () => {
    const options = acpDiscoveryOptionsForEnabledAgents(
      settingsWith({
        enabled: ["grok", "kimi"],
        agents: {
          grok: { overridePath: "  /custom/grok  " },
          kimi: { overridePath: "   " },
          qwen: { overridePath: "/custom/qwen" }
        }
      })
    );
    expect(options.overrides).toEqual({ grok: "/custom/grok" });
  });

  it("omits the overrides key entirely when there are none", () => {
    const options = acpDiscoveryOptionsForEnabledAgents(
      settingsWith({ enabled: ["grok"], agents: { grok: { selectedPath: "/pinned/grok" } } })
    );
    expect(options).not.toHaveProperty("overrides");
  });

  it("carries the caller's env through, and adds no env key when given none", () => {
    const env = { PATH: "/bin" };
    expect(acpDiscoveryOptionsForEnabledAgents(settingsWith({}), env).env).toBe(env);
    expect(acpDiscoveryOptionsForEnabledAgents(settingsWith({}))).not.toHaveProperty("env");
  });
});

describe("acpDiscoveryOptionsForInstallScan", () => {
  it("probes every PwrGit agent, so an installed-but-disabled one can be turned on", () => {
    const options = acpDiscoveryOptionsForInstallScan(settingsWith({ enabled: [] }));
    expect(ids(options.strategies)).toEqual([...BUILT_IN_ACP_AGENT_IDS]);
    expect(ids(options.strategies)).not.toContain("gemini");
  });

  it("does not run a path typed for a disabled agent until it is enabled", () => {
    const agents = {
      grok: { overridePath: "/custom/grok" },
      kimi: { overridePath: "/custom/kimi" }
    };
    expect(
      acpDiscoveryOptionsForInstallScan(settingsWith({ enabled: ["kimi"], agents })).overrides
    ).toEqual({ kimi: "/custom/kimi" });
    expect(
      acpDiscoveryOptionsForInstallScan(settingsWith({ enabled: [], agents }))
    ).not.toHaveProperty("overrides");
  });
});

describe("acpDiscoveryOptionsForEnabledAgent", () => {
  it("answers null for a disabled agent, so the caller neither probes nor spawns", () => {
    expect(acpDiscoveryOptionsForEnabledAgent(settingsWith({ enabled: ["kimi"] }), "grok")).toBeNull();
  });

  it("answers null for Gemini even when a stored list claims it is enabled", () => {
    const settings = settingsWith({});
    settings.acp.enabledAgentIds = ["gemini" as BuiltInAcpAgentId];
    expect(acpDiscoveryOptionsForEnabledAgent(settings, "gemini")).toBeNull();
  });

  it("probes just the one agent, with its override when it has one", () => {
    const options = acpDiscoveryOptionsForEnabledAgent(
      settingsWith({
        enabled: ["grok", "qwen"],
        agents: { qwen: { overridePath: " /custom/qwen " }, grok: { overridePath: "/custom/grok" } }
      }),
      "qwen",
      { PATH: "/bin" }
    );
    expect(ids(options?.strategies)).toEqual(["qwen"]);
    expect(options?.overrides).toEqual({ qwen: "/custom/qwen" });
    expect(options?.env).toEqual({ PATH: "/bin" });
  });

  it("omits overrides when the agent's override is blank", () => {
    const options = acpDiscoveryOptionsForEnabledAgent(
      settingsWith({ enabled: ["kimi"], agents: { kimi: { overridePath: "  " } } }),
      "kimi"
    );
    expect(ids(options?.strategies)).toEqual(["kimi"]);
    expect(options).not.toHaveProperty("overrides");
  });
});

describe("enabledAcpAgentIdsInUse", () => {
  const rebaseReview = AI_JOBS.rebaseReview;
  const original = rebaseReview.acp;
  afterEach(() => {
    rebaseReview.acp = original;
  });

  it("is empty while every job runs on Codex", () => {
    expect(enabledAcpAgentIdsInUse(settingsWith({ enabled: ["grok", "kimi", "qwen"] }))).toEqual([]);
  });

  it("does not count an agent routed to a job that refuses ACP", () => {
    // Rebase review is Codex-only: its row says Codex, so probing Grok for it
    // would spawn a CLI nothing uses.
    expect(
      enabledAcpAgentIdsInUse(settingsWith({ enabled: ["grok"], provider: "grok" }))
    ).toEqual([]);
  });

  it("counts an enabled agent routed to an ACP-capable job, and never a disabled one", () => {
    // No shipped job accepts ACP yet; open the only one to stand in for the
    // next job so the ACP half of the rule is exercised.
    rebaseReview.acp = true;
    expect(
      enabledAcpAgentIdsInUse(settingsWith({ enabled: ["grok"], provider: "grok" }))
    ).toEqual(["grok"]);
    expect(
      enabledAcpAgentIdsInUse(settingsWith({ enabled: ["kimi"], provider: "grok" }))
    ).toEqual([]);
  });
});
