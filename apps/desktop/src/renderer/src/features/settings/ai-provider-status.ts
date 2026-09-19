// One status read per AI provider, shared by the Settings nav's AI Providers
// children and the AI Providers pane's cards. Ported from PwrSnap's
// `ai-provider-status.ts` (itself from PwrAgnt's settings nav).
//
// Pure on purpose: the nav dot and the card chip for a provider are two
// renderings of ONE answer, so they cannot disagree — PwrAgnt shipped a green
// nav dot over a card that said the binary was broken when the two were
// computed separately.
//
// The dot is `aria-hidden`, so every state that is not "fine" also carries a
// word in `chip`, and `sentence` is the full statement a screen reader hears.
// Colour is the redundant channel, never the only one.

import {
  AI_JOB_IDS,
  AI_PROVIDER_IDS,
  aiProviderDisplayName,
  effectiveJobProvider,
  type AcpAgentDiscovery,
  type AcpAgentDiscoveryEntry,
  type AiJobId,
  type AiProviderId,
  type AiProviderSettings,
  type BuiltInAcpAgentId,
  type CodexProviderDiscovery
} from "@pwrgit/shared";
import type { SettingsChipTone } from "./SettingsLayout";

/**
 * - `ok`: configured and usable.
 * - `off`: not turned on — a choice, not a fault.
 * - `warn`: on and found, but needs attention (sign in, failed probe).
 * - `bad`: on, but cannot run (binary missing).
 *
 * The same four tones as the Forges nav (`ForgeNavDot`), so both groups paint
 * with the same `settings-nav__subdot--*` rules.
 */
export type AiProviderTone = "ok" | "off" | "warn" | "bad";

export type AiProviderStatus = {
  sub: AiProviderId;
  label: string;
  /** Absent while the answer is unknown. No dot reads as "we do not know",
   *  which is honest; a green one would be a guess. */
  tone?: AiProviderTone;
  /** Short word in the nav for every non-ok state — a remedy where there is
   *  one ("sign in"), because a nav row is where the reader decides what to
   *  do next. */
  chip?: string;
  /** Card chip text. */
  badge: string;
  /** Card description — where it lives, what version. */
  meta: string;
  /** The nav row's accessible name once there is a state to report. */
  sentence?: string;
};

export type AiProviderStatusInput = {
  codex: CodexProviderDiscovery | null;
  codexLoading: boolean;
  acpDiscovery: AcpAgentDiscovery | null;
  acpDiscoveryLoading: boolean;
  enabledAgentIds: readonly string[];
  /** Runtime probe failures from `aiProviders:acpModels`, keyed by agent id.
   *  Only the AI pages issue those probes; the nav just reflects them. */
  acpModelErrors: Readonly<Record<string, string | undefined>>;
};

function withSentence(status: AiProviderStatus): AiProviderStatus {
  return status.tone === undefined
    ? status
    : { ...status, sentence: `${status.label}: ${status.badge}` };
}

export function describeCodexStatus(
  snapshot: CodexProviderDiscovery | null,
  loading: boolean
): AiProviderStatus {
  const base = { sub: "codex" as const, label: aiProviderDisplayName("codex") };
  if (snapshot === null) {
    return {
      ...base,
      badge: loading ? "Checking…" : "Unknown",
      meta: "Discovery has not reported yet."
    };
  }
  if (snapshot.resolvedPath === null) {
    return withSentence({
      ...base,
      tone: "bad",
      chip: "missing",
      badge: "Not found",
      meta: "No usable Codex CLI was found on this machine."
    });
  }
  const version = snapshot.candidates.find(
    (candidate) => candidate.path === snapshot.resolvedPath
  )?.version;
  const meta =
    version !== null && version !== undefined
      ? `v${version} · ${snapshot.resolvedPath}`
      : snapshot.resolvedPath;
  if (snapshot.auth?.status === "unauthenticated") {
    return withSentence({ ...base, tone: "warn", chip: "sign in", badge: "Sign in", meta });
  }
  if (snapshot.auth?.status === "failed") {
    return withSentence({ ...base, tone: "warn", chip: "check", badge: "Sign-in check failed", meta });
  }
  return withSentence({ ...base, tone: "ok", badge: "Ready", meta });
}

/**
 * ACP agents are OPT-IN (nothing is enabled until the operator says so), so
 * "off" alone would paint every agent the same grey on a fresh install and
 * hide the one thing the row should say — whether the CLI is even there.
 * Disabled agents keep a grey dot but split their word: `off` (installed,
 * ready to enable) vs `missing` (nothing to enable).
 */
export function describeAcpAgentStatus(
  id: BuiltInAcpAgentId,
  entry: AcpAgentDiscoveryEntry | undefined,
  discoveryLoading: boolean,
  enabled: boolean,
  modelError: string | undefined
): AiProviderStatus {
  const label = entry?.displayName ?? aiProviderDisplayName(id);
  const base = { sub: id, label };
  if (entry === undefined) {
    if (!enabled) {
      return withSentence({ ...base, tone: "off", chip: "off", badge: "Off", meta: "Not enabled." });
    }
    return {
      ...base,
      badge: discoveryLoading ? "Checking…" : "Unknown",
      meta: "Discovery has not reported yet."
    };
  }
  const installedMeta = [
    entry.version !== undefined ? `v${entry.version}` : null,
    entry.activeCommand ?? null
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const meta = entry.installed
    ? installedMeta.length > 0
      ? installedMeta
      : "Installed"
    : (entry.detail ?? "Not installed");
  if (!enabled) {
    return withSentence(
      entry.installed
        ? { ...base, tone: "off", chip: "off", badge: "Off", meta }
        : { ...base, tone: "off", chip: "missing", badge: "Not installed", meta }
    );
  }
  if (!entry.installed) {
    return withSentence({ ...base, tone: "bad", chip: "missing", badge: "Not installed", meta });
  }
  if (modelError !== undefined) {
    return withSentence({ ...base, tone: "warn", chip: "error", badge: "Unavailable", meta: modelError });
  }
  return withSentence({ ...base, tone: "ok", badge: "Enabled", meta });
}

/** Every provider, in nav order. */
export function describeAiProviders(input: AiProviderStatusInput): AiProviderStatus[] {
  const enabled = new Set(input.enabledAgentIds);
  const byId = new Map(input.acpDiscovery?.agents.map((agent) => [agent.id, agent] as const) ?? []);
  return AI_PROVIDER_IDS.map((id) =>
    id === "codex"
      ? describeCodexStatus(input.codex, input.codexLoading)
      : describeAcpAgentStatus(
          id,
          byId.get(id),
          input.acpDiscoveryLoading,
          enabled.has(id),
          input.acpModelErrors[id]
        )
  );
}

/** A tone as the card chip's tone. `bad` is `err` there; `off` is neutral. */
export function aiProviderChipTone(tone: AiProviderTone | undefined): SettingsChipTone {
  switch (tone) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "bad":
      return "err";
    default:
      return "default";
  }
}

/**
 * The jobs that will actually RUN on `sub`, in AI Features order.
 *
 * Mirrors the runtime through `effectiveJobProvider`, not the stored string:
 * an unset provider, a disabled agent, and an agent on a Codex-only job all
 * land on Codex, so a Codex card that only counted literal "codex" would claim
 * no jobs while every job ran through it.
 */
export function routedJobs(settings: AiProviderSettings | null, sub: AiProviderId): AiJobId[] {
  if (settings === null) return [];
  return AI_JOB_IDS.filter((jobId) => effectiveJobProvider(settings, jobId) === sub);
}

/**
 * The enabled ACP agents some job is routed to — the ones whose model list the
 * AI pages probe. A probe spawns the agent, so an agent no job runs on is
 * never started just to fill a picker nobody is looking at.
 */
export function enabledAcpAgentIdsForModelProbes(
  settings: AiProviderSettings | null
): BuiltInAcpAgentId[] {
  if (settings === null) return [];
  return [
    ...new Set(
      AI_JOB_IDS.map((jobId) => effectiveJobProvider(settings, jobId)).filter(
        (provider): provider is BuiltInAcpAgentId => provider !== "codex"
      )
    )
  ];
}
