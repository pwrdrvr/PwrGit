// AI providers — the agents PwrGit can hand work to, and the per-profile
// choices about which one does each job.
//
// Ported from PwrSnap's Settings → AI (`packages/shared/src/protocol.ts`,
// "ACP agents" and "Per-surface AI defaults"). PwrGit has no AI of its own: it
// drives a Codex CLI or an ACP agent CLI the operator already has, signed in to
// their own account. These shapes are what main discovers and persists and
// what Settings → AI Providers / AI Features render.
//
// This is NOT Settings → Local Agents (`mcp-policy.ts`), which governs agents
// connecting TO PwrGit over MCP. These are agents PwrGit connects to.
//
// Gemini CLI is deliberately absent. The kit still ships a Gemini strategy,
// but it does not work for regular accounts and can open auth UI during a
// probe, so PwrGit never lists, probes, or accepts it.

import type { ProfileId } from "./types";

// ---- Providers ------------------------------------------------------------

/** The kit's built-in ACP strategy ids PwrGit offers, in display order. Keep in
 *  step with `BUILT_IN_ACP_STRATEGIES` in `@pwrdrvr/agent-acp`: an id missing
 *  here is simply never probed, so a mismatch narrows the set, never widens it. */
export const BUILT_IN_ACP_AGENT_IDS = ["grok", "kimi", "qwen"] as const;

export type BuiltInAcpAgentId = (typeof BUILT_IN_ACP_AGENT_IDS)[number];

export function isBuiltInAcpAgentId(value: unknown): value is BuiltInAcpAgentId {
  return (
    typeof value === "string" &&
    (BUILT_IN_ACP_AGENT_IDS as readonly string[]).includes(value)
  );
}

/** Friendly names, kept in step with the kit strategies' `displayName`, so a
 *  configured agent is labelled from settings immediately instead of flashing
 *  its raw id until discovery answers. */
const BUILT_IN_ACP_AGENT_DISPLAY_NAMES: Readonly<Record<BuiltInAcpAgentId, string>> = {
  grok: "Grok",
  kimi: "Kimi Code CLI",
  qwen: "Qwen Code"
};

/** The friendly name for an ACP agent id, or the id itself for one PwrGit does
 *  not know, so an unexpected value still shows something. */
export function builtInAcpAgentDisplayName(id: string): string {
  return isBuiltInAcpAgentId(id) ? BUILT_IN_ACP_AGENT_DISPLAY_NAMES[id] : id;
}

/** Every provider, in the order Settings lists them: Codex first, then the ACP
 *  agents. Also the `sub` allowlist for Settings → AI Providers. */
export const AI_PROVIDER_IDS = ["codex", ...BUILT_IN_ACP_AGENT_IDS] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return (
    typeof value === "string" &&
    (AI_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function aiProviderDisplayName(id: AiProviderId): string {
  return id === "codex" ? "Codex" : builtInAcpAgentDisplayName(id);
}

// ---- Jobs -----------------------------------------------------------------

/**
 * Work PwrGit hands to an agent. Each carries its own provider / model /
 * reasoning default, the way PwrSnap's surfaces do.
 *
 * One job today. A job is a registry entry rather than a field, so the next one
 * (a commit-message draft, a PR description) arrives the way a forge product
 * does: as a member here plus its details, with the Settings rows following.
 */
export const AI_JOB_IDS = ["rebaseReview"] as const;

export type AiJobId = (typeof AI_JOB_IDS)[number];

export function isAiJobId(value: unknown): value is AiJobId {
  return typeof value === "string" && (AI_JOB_IDS as readonly string[]).includes(value);
}

export type AiJobDetails = {
  label: string;
  description: string;
  /**
   * Whether an ACP agent may run this job. `false` means only Codex is offered,
   * and a stored ACP choice resolves to Codex — never to an agent the job cannot
   * hold to its boundary.
   */
  acp: boolean;
  /** Said beside the provider picker when `acp` is false, so the operator is
   *  not left wondering why their enabled agent is missing from it. */
  acpUnavailableReason?: string;
};

export const AI_JOBS: Readonly<Record<AiJobId, AiJobDetails>> = {
  rebaseReview: {
    label: "Rebase review",
    description:
      "Reviews the rebase plan PwrGit computed and explains it. Proposal-only: it never edits history.",
    acp: false,
    acpUnavailableReason:
      "ACP agents can't be held to the no-tools boundary a rebase review runs under, so this job runs on Codex."
  }
};

// ---- Reasoning ------------------------------------------------------------

/** Reasoning effort sent to the chosen backend. Codex's App Server defines it as
 *  an open string and advertises the valid values per model, so this is not a
 *  closed union. */
export type AiReasoningEffort = string;

/** Fallback when a model advertises no efforts of its own. Live Codex choices
 *  come from `model/list`. */
export const AI_REASONING_EFFORTS = ["low", "medium", "high"] as const;

export function isAiReasoningEffort(value: unknown): value is AiReasoningEffort {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 40 &&
    /^[a-z0-9_-]+$/.test(value)
  );
}

/** A model id as a backend reports it. Shape-checked only: which ids are real is
 *  the backend's call, and it changes without a PwrGit release. */
export function isAiModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:/@+-]+$/.test(value)
  );
}

// ---- Per-profile settings -------------------------------------------------

export type CodexSelectionMode = "auto" | "pinned";

export type AiCodexSettings = {
  /** `auto` runs the newest usable Codex found on disk; `pinned` runs
   *  `pinnedPath` while it is usable and falls back to discovery when not. */
  mode: CodexSelectionMode;
  /** "" when nothing is pinned. */
  pinnedPath: string;
  /**
   * The Codex auth profile (a CODEX_HOME) this PwrGit profile signs in with.
   *
   * - absent: follow the PwrGit profile — a signed-in Codex profile of the same
   *   name when there is one, else the System default. Two PwrGit profiles
   *   named after two Codex accounts then need no configuration at all.
   * - `""`: the System default (`~/.codex`), always.
   * - a name: that `~/.codex/profiles/<name>` directory, always.
   */
  authProfile?: string;
};

/** One agent's path choice. Both unset = auto (first discovered install). */
export type AcpAgentPreference = {
  /** Manual absolute path. Wins over everything while it passes the probe. */
  overridePath?: string;
  /** A discovered install the operator pinned. */
  selectedPath?: string;
};

export type AiAcpSettings = {
  /** Opt-in, as in PwrSnap: nothing is enabled until the operator says so. */
  enabledAgentIds: BuiltInAcpAgentId[];
  agents: Partial<Record<BuiltInAcpAgentId, AcpAgentPreference>>;
};

/** One job's choices. An absent field means "the backend's own default", so a
 *  later release can move an unpinned choice without rewriting settings. */
export type AiJobDefault = {
  provider?: AiProviderId;
  model?: string;
  reasoning?: AiReasoningEffort;
};

/** Longest guidance PwrGit keeps. It rides along with every job's prompt. */
export const AI_GUIDANCE_MAX_LENGTH = 4000;

export type AiProviderSettings = {
  /**
   * The profile's master switch for AI features, off until the operator turns
   * it on. Discovery and these settings work either way, so an agent can be
   * set up before anything is allowed to run; `resolveJob` refuses every job
   * while this is false.
   */
  enabled: boolean;
  /** ISO-8601, stamped when the operator accepted the disclosure; null until
   *  then. `enabled` cannot be true without it — main enforces that. */
  consentAcceptedAt: string | null;
  codex: AiCodexSettings;
  acp: AiAcpSettings;
  jobs: Record<AiJobId, AiJobDefault>;
  /** Free-form preferences added to every job's instructions. Never a grant:
   *  it cannot widen what a job may do. */
  guidance: string;
};

export const DEFAULT_AI_PROVIDER_SETTINGS: AiProviderSettings = {
  enabled: false,
  consentAcceptedAt: null,
  codex: { mode: "auto", pinnedPath: "" },
  acp: { enabledAgentIds: [], agents: {} },
  jobs: { rebaseReview: {} },
  guidance: ""
};

/**
 * A patch. `""` is how a field is cleared back to its default — `provider`,
 * `model`, `reasoning`, `pinnedPath`, and either path preference — and
 * `authProfile: null` returns Codex to following the PwrGit profile (where `""`
 * would pin the System default instead).
 */
export type AiProviderSettingsPatch = {
  enabled?: boolean;
  /** Sent with the `enabled: true` that accepts the disclosure. There is no
   *  way to un-accept: the disclosure describes PwrGit, not a session. */
  consentAcceptedAt?: string;
  codex?: {
    mode?: CodexSelectionMode;
    pinnedPath?: string;
    authProfile?: string | null;
  };
  acp?: {
    enabledAgentIds?: BuiltInAcpAgentId[];
    agents?: Partial<Record<BuiltInAcpAgentId, AcpAgentPreference>>;
  };
  jobs?: Partial<
    Record<
      AiJobId,
      { provider?: AiProviderId | ""; model?: string; reasoning?: AiReasoningEffort | "" }
    >
  >;
  guidance?: string;
};

export type AiProviderSettingsSnapshot = {
  profileId: ProfileId;
  settings: AiProviderSettings;
};

/**
 * The provider a job will actually run on, from the stored choice.
 *
 * Mirrors the runtime, not the string: an unset provider, an ACP agent that is
 * no longer enabled, and an ACP agent on a job that does not accept one all
 * land on Codex. The Settings screens and main's resolver both ask this, so
 * the provider a row claims and the one that runs cannot disagree.
 */
export function effectiveJobProvider(
  settings: AiProviderSettings,
  jobId: AiJobId
): AiProviderId {
  const provider = settings.jobs[jobId]?.provider;
  if (provider === undefined || provider === "codex") return "codex";
  if (!AI_JOBS[jobId].acp) return "codex";
  return settings.acp.enabledAgentIds.includes(provider) ? provider : "codex";
}

// ---- Discovery ------------------------------------------------------------

/** Where a Codex candidate came from: the PWRDRVR_CODEX_COMMAND override, the
 *  pinned path, a PATH hit, or a well-known install location. */
export type CodexCandidateSource = "env" | "config" | "path" | "application";

export type CodexCandidate = {
  path: string;
  source: CodexCandidateSource;
  version: string | null;
  /** Runs, and is new enough for PwrGit to drive. */
  available: boolean;
  /** Why it is not available, when it is not. */
  failureReason?: string;
};

export type CodexAuthStatus = "authenticated" | "unauthenticated" | "failed";

export type CodexAuthState = {
  status: CodexAuthStatus;
  /** The Codex auth profile checked: "" for the System default. */
  profile: string;
  /** "System default" or the profile name. */
  profileLabel: string;
  codexHome: string;
  email?: string;
  planType?: string;
  /** What `codex login status` said, trimmed — the evidence for `status`. */
  detail?: string;
};

export type CodexProviderDiscovery = {
  candidates: CodexCandidate[];
  /** The binary the next spawn will use, or null when none is usable. The
   *  "Using" marker follows this, never the mode, so the screen cannot claim a
   *  binary other than the one that runs. */
  resolvedPath: string | null;
  /** Sign-in for `resolvedPath` under this profile's CODEX_HOME. Null when no
   *  binary resolved. */
  auth: CodexAuthState | null;
  refreshedAt: string;
};

export type CodexAuthProfileOption = {
  /** "" for the System default. */
  name: string;
  displayName: string;
  codexHome: string;
  hasAuthFile: boolean;
  email?: string;
};

export type CodexAuthProfileList = {
  profiles: CodexAuthProfileOption[];
  /** The profile `authProfile: absent` resolves to right now — what the
   *  "Follow profile" choice would sign in with. */
  followed: string;
  error?: string;
};

export type CodexLoginResult = {
  profile: string;
  started: boolean;
  authenticated?: boolean;
  detail?: string;
};

export type AcpAgentInstanceSource = "override" | "path" | "fallback";

/** One install of an ACP agent that passed the kit's probe. */
export type AcpAgentInstance = {
  command: string;
  version?: string;
  source: AcpAgentInstanceSource;
};

export type AcpAgentDiscoveryEntry = {
  id: BuiltInAcpAgentId;
  displayName: string;
  /** The only authoritative install signal: the kit's probe passed. */
  installed: boolean;
  /** Version of the active install. */
  version?: string;
  /** The active install's path, or an install hint when there is none. */
  detail?: string;
  /** Every install found, in candidate order. */
  instances: AcpAgentInstance[];
  /** The install spawns use: override → pinned → first found. */
  activeCommand?: string;
};

export type AcpAgentDiscovery = {
  agents: AcpAgentDiscoveryEntry[];
};

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  /** Efforts this model accepts, as `model/list` advertises them. */
  supportedReasoningEfforts: AiReasoningEffort[];
  defaultReasoningEffort: AiReasoningEffort | null;
  isDefault: boolean;
};

export type CodexModelList = {
  models: CodexModelOption[];
};

export type AcpAgentModelOption = {
  id: string;
  label: string;
  description?: string;
  /** The agent's reported current model, when it names one. */
  isDefault?: boolean;
};

export type AcpAgentModelList = {
  agentId: BuiltInAcpAgentId;
  models: AcpAgentModelOption[];
};
