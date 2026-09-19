// Per-profile AI provider settings: which Codex runs and signs in as whom,
// which ACP agents are enabled, and each job's provider / model / reasoning.
//
// PwrSnap keeps these in its one settings file because PwrSnap has one user.
// PwrGit's equivalent of "the user" is a profile — work and personal are
// usually different Codex accounts — so they live beside the profile, in
// `app_meta` under the profile's reserved `profile:<id>:` namespace. That is
// what makes them deletion-safe: `ProfileService.delete` clears the namespace
// without having to learn this key.
//
// Everything that arrives here crossed IPC or came off disk, so both paths go
// through the same narrowing: unknown keys dropped, ids checked against the
// allowlists (Gemini is not on them), strings trimmed and bounded.

import {
  AI_GUIDANCE_MAX_LENGTH,
  AI_JOB_IDS,
  BUILT_IN_ACP_AGENT_IDS,
  DEFAULT_AI_PROVIDER_SETTINGS,
  isAiModelId,
  isAiProviderId,
  isAbsoluteExecutablePath,
  isAiReasoningEffort,
  isBuiltInAcpAgentId,
  type AcpAgentPreference,
  type AiJobDefault,
  type AiJobId,
  type AiProviderSettings,
  type AiProviderSettingsPatch,
  type BuiltInAcpAgentId,
  type ProfileId
} from "@pwrgit/shared";
import { isValidProfileName } from "@pwrdrvr/codex-discovery";
import type { DB } from "../persistence/db";

/** Longest path PwrGit stores. Real paths are far shorter; this only stops a
 *  hostile or corrupt value from growing the row without bound. */
const MAX_PATH_LENGTH = 4096;

const settingsKey = (profileId: ProfileId): string =>
  `profile:${profileId}:ai-providers`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A trimmed absolute path, `""` for an explicit clear, or undefined for
 *  anything else. The pane validates first and says why; this is the backstop
 *  for what it cannot vouch for — a relative path would be spawned against
 *  whatever directory main happens to be in. */
function pathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed.length > MAX_PATH_LENGTH) return undefined;
  return isAbsoluteExecutablePath(process.platform, trimmed) ? trimmed : undefined;
}

/** Guidance keeps its line breaks (as `\n`, whatever the platform typed) and
 *  tabs, and loses every other control character, C1 included — it is text a
 *  person typed, bound for a prompt. */
function guidanceValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return cleaned.slice(0, AI_GUIDANCE_MAX_LENGTH);
}

function agentIds(value: unknown): BuiltInAcpAgentId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(isBuiltInAcpAgentId))];
}

function preference(value: unknown): AcpAgentPreference | undefined {
  const raw = record(value);
  if (raw === null) return undefined;
  const out: AcpAgentPreference = {};
  const overridePath = pathValue(raw["overridePath"]);
  const selectedPath = pathValue(raw["selectedPath"]);
  if (overridePath !== undefined) out.overridePath = overridePath;
  if (selectedPath !== undefined) out.selectedPath = selectedPath;
  return out;
}

/**
 * Keep only a well-formed patch. Clears survive as `""` (and
 * `authProfile: null`) because they are instructions, not absences: dropping
 * one would leave a stale choice on disk that no control can remove.
 */
export function sanitizeAiProviderSettingsPatch(value: unknown): AiProviderSettingsPatch {
  const raw = record(value) ?? {};
  const patch: AiProviderSettingsPatch = {};

  const codex = record(raw["codex"]);
  if (codex !== null) {
    const next: NonNullable<AiProviderSettingsPatch["codex"]> = {};
    const mode = codex["mode"];
    if (mode === "auto" || mode === "pinned") next.mode = mode;
    const pinnedPath = pathValue(codex["pinnedPath"]);
    if (pinnedPath !== undefined) next.pinnedPath = pinnedPath;
    const authProfile = codex["authProfile"];
    if (authProfile === null || authProfile === "") next.authProfile = authProfile;
    else if (typeof authProfile === "string" && isValidProfileName(authProfile.trim())) {
      next.authProfile = authProfile.trim();
    }
    if (Object.keys(next).length > 0) patch.codex = next;
  }

  const acp = record(raw["acp"]);
  if (acp !== null) {
    const next: NonNullable<AiProviderSettingsPatch["acp"]> = {};
    const enabled = agentIds(acp["enabledAgentIds"]);
    if (enabled !== undefined) next.enabledAgentIds = enabled;
    const agents = record(acp["agents"]);
    if (agents !== null) {
      const prefs: Partial<Record<BuiltInAcpAgentId, AcpAgentPreference>> = {};
      for (const [id, pref] of Object.entries(agents)) {
        if (!isBuiltInAcpAgentId(id)) continue;
        const cleaned = preference(pref);
        if (cleaned !== undefined && Object.keys(cleaned).length > 0) prefs[id] = cleaned;
      }
      if (Object.keys(prefs).length > 0) next.agents = prefs;
    }
    if (Object.keys(next).length > 0) patch.acp = next;
  }

  const jobs = record(raw["jobs"]);
  if (jobs !== null) {
    const next: NonNullable<AiProviderSettingsPatch["jobs"]> = {};
    for (const jobId of AI_JOB_IDS) {
      const job = record(jobs[jobId]);
      if (job === null) continue;
      const out: NonNullable<NonNullable<AiProviderSettingsPatch["jobs"]>[AiJobId]> = {};
      const provider = job["provider"];
      if (provider === "" || isAiProviderId(provider)) out.provider = provider;
      const model = job["model"];
      if (model === "" || isAiModelId(model)) out.model = model;
      const reasoning = job["reasoning"];
      if (reasoning === "" || isAiReasoningEffort(reasoning)) out.reasoning = reasoning;
      if (Object.keys(out).length > 0) next[jobId] = out;
    }
    if (Object.keys(next).length > 0) patch.jobs = next;
  }

  const guidance = guidanceValue(raw["guidance"]);
  if (guidance !== undefined) patch.guidance = guidance;

  return patch;
}

/**
 * Apply a sanitized patch. Merges field by field — the screens send one field
 * at a time, and a wholesale write would erase every other choice on each
 * click — and turns every clear into an absence, so what is stored is only
 * what somebody chose.
 */
export function applyAiProviderSettingsPatch(
  current: AiProviderSettings,
  patch: AiProviderSettingsPatch
): AiProviderSettings {
  const codex = { ...current.codex };
  if (patch.codex?.mode !== undefined) codex.mode = patch.codex.mode;
  if (patch.codex?.pinnedPath !== undefined) codex.pinnedPath = patch.codex.pinnedPath;
  if (patch.codex?.authProfile !== undefined) {
    if (patch.codex.authProfile === null) delete codex.authProfile;
    else codex.authProfile = patch.codex.authProfile;
  }

  const agents = { ...current.acp.agents };
  for (const id of BUILT_IN_ACP_AGENT_IDS) {
    const pref = patch.acp?.agents?.[id];
    if (pref === undefined) continue;
    const merged: AcpAgentPreference = { ...agents[id], ...pref };
    if (merged.overridePath === "") delete merged.overridePath;
    if (merged.selectedPath === "") delete merged.selectedPath;
    if (Object.keys(merged).length === 0) delete agents[id];
    else agents[id] = merged;
  }

  const jobs = { ...current.jobs };
  for (const jobId of AI_JOB_IDS) {
    const jobPatch = patch.jobs?.[jobId];
    if (jobPatch === undefined) continue;
    const merged: AiJobDefault = { ...jobs[jobId] };
    if (jobPatch.provider !== undefined) {
      if (jobPatch.provider === "") delete merged.provider;
      else merged.provider = jobPatch.provider;
    }
    if (jobPatch.model !== undefined) {
      if (jobPatch.model === "") delete merged.model;
      else merged.model = jobPatch.model;
    }
    if (jobPatch.reasoning !== undefined) {
      if (jobPatch.reasoning === "") delete merged.reasoning;
      else merged.reasoning = jobPatch.reasoning;
    }
    jobs[jobId] = merged;
  }

  return {
    codex,
    acp: {
      enabledAgentIds: patch.acp?.enabledAgentIds ?? [...current.acp.enabledAgentIds],
      agents
    },
    jobs,
    guidance: patch.guidance ?? current.guidance
  };
}

/**
 * Settings read back off disk, fully defaulted. The stored JSON is replayed
 * through the patch sanitizer onto the defaults, so a row written by an older
 * build — or edited by hand — cannot hand main an id or a shape it would not
 * have accepted from the renderer. A stored Gemini choice from anywhere simply
 * disappears.
 */
export function normalizeStoredAiProviderSettings(value: unknown): AiProviderSettings {
  return applyAiProviderSettingsPatch(
    structuredClone(DEFAULT_AI_PROVIDER_SETTINGS),
    sanitizeAiProviderSettingsPatch(value)
  );
}

/** Reads and writes one profile's settings. Electron-free, so tests drive it
 *  against an in-memory database. */
export class AiProviderSettingsStore {
  constructor(private readonly db: DB) {}

  read(profileId: ProfileId): AiProviderSettings {
    const row = this.db
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(settingsKey(profileId)) as { value: string } | undefined;
    if (row === undefined) return structuredClone(DEFAULT_AI_PROVIDER_SETTINGS);
    try {
      return normalizeStoredAiProviderSettings(JSON.parse(row.value));
    } catch {
      return structuredClone(DEFAULT_AI_PROVIDER_SETTINGS);
    }
  }

  /** Merge a patch that has already been sanitized. */
  update(profileId: ProfileId, patch: AiProviderSettingsPatch): AiProviderSettings {
    const next = applyAiProviderSettingsPatch(this.read(profileId), patch);
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(settingsKey(profileId), JSON.stringify(next));
    return next;
  }
}
