import { describe, expect, it } from "vitest";
import {
  AI_JOB_IDS,
  AI_JOBS,
  AI_PROVIDER_IDS,
  AI_REASONING_EFFORTS,
  aiProviderDisplayName,
  builtInAcpAgentDisplayName,
  BUILT_IN_ACP_AGENT_IDS,
  DEFAULT_AI_PROVIDER_SETTINGS,
  effectiveJobProvider,
  isAiModelId,
  isAiProviderId,
  isAiReasoningEffort,
  isBuiltInAcpAgentId,
  type AiJobDefault,
  type AiProviderSettings,
  type BuiltInAcpAgentId
} from "./ai-providers";

describe("isBuiltInAcpAgentId", () => {
  it("accepts the ACP agents PwrGit offers", () => {
    for (const id of BUILT_IN_ACP_AGENT_IDS) expect(isBuiltInAcpAgentId(id)).toBe(true);
  });

  it("never accepts Gemini, though the kit still ships a strategy for it", () => {
    // Gemini can open auth UI during a probe, so PwrGit never lists, probes, or
    // accepts it — and this guard is where "accepts" is decided.
    expect(isBuiltInAcpAgentId("gemini")).toBe(false);
  });

  it("does not count Codex as an ACP agent", () => {
    expect(isBuiltInAcpAgentId("codex")).toBe(false);
  });

  it("rejects a near miss and a non-string", () => {
    expect(isBuiltInAcpAgentId("Grok")).toBe(false);
    expect(isBuiltInAcpAgentId("")).toBe(false);
    expect(isBuiltInAcpAgentId(undefined)).toBe(false);
  });
});

describe("isAiProviderId", () => {
  it("accepts Codex and every offered ACP agent", () => {
    expect(isAiProviderId("codex")).toBe(true);
    for (const id of BUILT_IN_ACP_AGENT_IDS) expect(isAiProviderId(id)).toBe(true);
  });

  it("lists Codex first, then the ACP agents", () => {
    expect(AI_PROVIDER_IDS).toEqual(["codex", ...BUILT_IN_ACP_AGENT_IDS]);
  });

  it("rejects Gemini, casing variants and non-strings", () => {
    expect(isAiProviderId("gemini")).toBe(false);
    expect(isAiProviderId("Codex")).toBe(false);
    expect(isAiProviderId("")).toBe(false);
    expect(isAiProviderId(null)).toBe(false);
  });
});

describe("aiProviderDisplayName", () => {
  it("labels every provider with a friendly name rather than its raw id", () => {
    expect(aiProviderDisplayName("codex")).toBe("Codex");
    // Kept in step with the kit strategies' own displayName.
    expect(aiProviderDisplayName("grok")).toBe("Grok");
    expect(aiProviderDisplayName("kimi")).toBe("Kimi Code CLI");
    expect(aiProviderDisplayName("qwen")).toBe("Qwen Code");
  });

  it("shows an ACP id PwrGit does not know as itself rather than nothing", () => {
    expect(builtInAcpAgentDisplayName("gemini")).toBe("gemini");
  });
});

describe("isAiReasoningEffort", () => {
  it("accepts the fallback efforts and ones a model advertises beyond them", () => {
    // An open string: Codex advertises the valid values per model.
    for (const effort of AI_REASONING_EFFORTS) expect(isAiReasoningEffort(effort)).toBe(true);
    expect(isAiReasoningEffort("minimal")).toBe(true);
    expect(isAiReasoningEffort("xhigh")).toBe(true);
    expect(isAiReasoningEffort("extra_high-2")).toBe(true);
  });

  it("bounds the length", () => {
    expect(isAiReasoningEffort("")).toBe(false);
    expect(isAiReasoningEffort("a".repeat(40))).toBe(true);
    expect(isAiReasoningEffort("a".repeat(41))).toBe(false);
  });

  it("rejects uppercase, spaces and punctuation", () => {
    expect(isAiReasoningEffort("High")).toBe(false);
    expect(isAiReasoningEffort("very high")).toBe(false);
    expect(isAiReasoningEffort("high;")).toBe(false);
    expect(isAiReasoningEffort(3)).toBe(false);
  });
});

describe("isAiModelId", () => {
  it("accepts the shapes backends report", () => {
    expect(isAiModelId("gpt-5.1-codex")).toBe(true);
    expect(isAiModelId("moonshotai/kimi-k2:latest")).toBe(true);
    expect(isAiModelId("qwen3-coder-plus")).toBe(true);
    expect(isAiModelId("org@model+v2")).toBe(true);
  });

  it("bounds the length", () => {
    expect(isAiModelId("")).toBe(false);
    expect(isAiModelId("m".repeat(200))).toBe(true);
    expect(isAiModelId("m".repeat(201))).toBe(false);
  });

  it("rejects whitespace, shell metacharacters and non-ASCII", () => {
    expect(isAiModelId("   ")).toBe(false);
    expect(isAiModelId("gpt 5")).toBe(false);
    expect(isAiModelId("gpt-5\n")).toBe(false);
    expect(isAiModelId("gpt-5;rm")).toBe(false);
    expect(isAiModelId("$(model)")).toBe(false);
    expect(isAiModelId("modèle")).toBe(false);
    expect(isAiModelId(undefined)).toBe(false);
  });
});

describe("effectiveJobProvider", () => {
  function settings(
    job: AiJobDefault,
    enabledAgentIds: BuiltInAcpAgentId[] = []
  ): AiProviderSettings {
    return {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds, agents: {} },
      jobs: { ...DEFAULT_AI_PROVIDER_SETTINGS.jobs, historyEditing: job }
    };
  }

  it("runs an unset job on Codex", () => {
    expect(effectiveJobProvider(DEFAULT_AI_PROVIDER_SETTINGS, "historyEditing")).toBe("codex");
    expect(effectiveJobProvider(settings({ model: "gpt-5.1-codex" }), "historyEditing")).toBe(
      "codex"
    );
  });

  it("runs a job whose settings predate it on Codex rather than throwing", () => {
    // A blob written before the job existed has no entry for it at all.
    const stale = { ...DEFAULT_AI_PROVIDER_SETTINGS, jobs: {} } as unknown as AiProviderSettings;
    expect(effectiveJobProvider(stale, "historyEditing")).toBe("codex");
  });

  it("runs a job pinned to Codex on Codex", () => {
    expect(effectiveJobProvider(settings({ provider: "codex" }, ["grok"]), "historyEditing")).toBe(
      "codex"
    );
  });

  it("runs history editing on Codex even when an enabled ACP agent is stored for it", () => {
    // The job cannot hold an ACP agent to its no-tools boundary, so the stored
    // choice is overridden rather than honoured — the enablement is irrelevant.
    expect(AI_JOBS.historyEditing.acp).toBe(false);
    expect(
      effectiveJobProvider(settings({ provider: "grok" }, ["grok", "kimi"]), "historyEditing")
    ).toBe("codex");
  });

  it("runs a job whose stored ACP agent is no longer enabled on Codex", () => {
    expect(effectiveJobProvider(settings({ provider: "kimi" }, ["grok"]), "historyEditing")).toBe(
      "codex"
    );
    expect(effectiveJobProvider(settings({ provider: "kimi" }), "historyEditing")).toBe("codex");
  });

  it.each(AI_JOB_IDS)("routes %s to an enabled agent exactly when the job accepts one", (jobId) => {
    // Every job today is Codex-only, so this pins that arm; a job that accepts
    // ACP picks up the other arm here without a new test.
    const stored: AiProviderSettings = {
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      acp: { enabledAgentIds: ["qwen"], agents: {} },
      jobs: { ...DEFAULT_AI_PROVIDER_SETTINGS.jobs, [jobId]: { provider: "qwen" } }
    };
    const disabled: AiProviderSettings = {
      ...stored,
      acp: { enabledAgentIds: ["grok"], agents: {} }
    };
    expect(effectiveJobProvider(stored, jobId)).toBe(AI_JOBS[jobId].acp ? "qwen" : "codex");
    expect(effectiveJobProvider(disabled, jobId)).toBe("codex");
  });
});
