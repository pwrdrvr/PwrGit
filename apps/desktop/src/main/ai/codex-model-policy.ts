import {
  AI_JOB_IDS,
  effectiveJobProvider,
  type AiCodexSettings,
  type AiProviderSettings,
  type AiProviderSettingsPatch,
  type CodexModelOption
} from "@pwrgit/shared";

const SOL_DEFAULT_SOURCES = new Set(["gpt-5.4", "gpt-5.6-terra", "gpt-5.6", "gpt-6-sol"]);

/** Return only a replacement this runtime advertises as selectable. */
function replacementModel(id: string | undefined, models: readonly CodexModelOption[]) {
  const target = id === "gpt-5.6-luna" ? "gpt-6-luna"
    : id !== undefined && SOL_DEFAULT_SOURCES.has(id) ? "gpt-6.1-sol" : undefined;
  return target === undefined ? undefined : models.find((model) => model.id === target && !model.hidden);
}

/** Keep raw catalog entries in the caches; hiding is recomputed for each list.
 * A runtime without a selectable Sol keeps offering its previous models. */
export function codexModelChoices(models: readonly CodexModelOption[]): CodexModelOption[] {
  const hasSol = models.some((model) => !model.hidden &&
    (model.id === "gpt-6-sol" || model.id === "gpt-6.1-sol"));
  return models.map((model) => hasSol &&
    /^gpt-5\.(?:4|5|6)(?:$|[-.])/u.test(model.id)
    ? { ...model, hidden: true } : model);
}

/** Re-read settings before applying this patch so a listing awaiting Codex
 * cannot overwrite a newer model choice or another account's defaults. */
export function codexDefaultMigration(
  settings: AiProviderSettings,
  models: readonly CodexModelOption[],
  expectedCodex: AiCodexSettings
): AiProviderSettingsPatch | undefined {
  if (settings.codex.mode !== expectedCodex.mode ||
    settings.codex.pinnedPath !== expectedCodex.pinnedPath ||
    settings.codex.authProfile !== expectedCodex.authProfile) return undefined;
  const jobs: NonNullable<AiProviderSettingsPatch["jobs"]> = {};
  for (const jobId of AI_JOB_IDS) {
    if (effectiveJobProvider(settings, jobId) !== "codex") continue;
    const job = settings.jobs[jobId];
    const replacement = replacementModel(job.model, models);
    if (replacement === undefined) continue;
    jobs[jobId] = {
      model: replacement.id,
      ...(job.reasoning !== undefined && replacement.supportedReasoningEfforts.length > 0 &&
        !replacement.supportedReasoningEfforts.includes(job.reasoning) ? { reasoning: "" } : {})
    };
  }
  return Object.keys(jobs).length === 0 ? undefined : { jobs };
}
