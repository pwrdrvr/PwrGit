import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_GUIDANCE_MAX_LENGTH,
  AI_JOB_IDS,
  AI_JOBS,
  AI_REASONING_EFFORTS,
  aiProviderDisplayName,
  effectiveJobProvider,
  isAiProviderId,
  isAiReasoningEffort,
  type AiJobId,
  type AiProviderId,
  type AiProviderSettingsPatch,
  type CodexModelOption,
  type ProfileId
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { AiProfilePicker, type AiProfileSelection } from "./AiProfilePicker";
import { useAiProvidersContext, useInUseAcpModelProbes } from "./AiProvidersContext";
import { AI_FEATURE_SECTION_LABELS } from "./settings-nav";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  type SettingsFocusRequest
} from "./SettingsLayout";

/** What `aiProviders:codexModels` answered, and for which profile and binary. */
type CodexModelsRead = {
  key: string;
  models: readonly CodexModelOption[];
  error: string | null;
};

/**
 * Settings → AI Features: what each feature runs on, and the guidance every
 * feature carries. Ported from PwrSnap's `AIFeaturesPage`, less the parts
 * PwrGit has no use for (capture enrichment, chat, budgets) and less Usage —
 * PwrGit does not account runs yet, and an empty usage card would promise one.
 *
 * Model lists come from the provider that will run the job: Codex's
 * `model/list` for Codex, the agent's own session for an ACP agent. A model id
 * only means something to the backend that advertised it, so switching the
 * provider resets the model rather than carrying one across.
 */
export function AiFeaturesSettings(props: {
  profile: AiProfileSelection;
  focusSection?: SettingsFocusRequest;
}) {
  const ai = useAiProvidersContext();
  const { request, profileId, codexSnapshot, fetchAcpModels } = ai;
  useEffect(() => request(), [request]);
  const probeIds = useInUseAcpModelProbes();

  // Codex's list is keyed by exactly what main caches it by — the binary and
  // the account — so it is re-read when either moves and not otherwise.
  const resolved = codexSnapshot?.resolvedPath ?? null;
  const codexKey =
    profileId === null || resolved === null
      ? null
      : JSON.stringify([profileId, resolved, codexSnapshot?.auth?.codexHome ?? null]);
  const [codexModels, setCodexModels] = useState<CodexModelsRead | null>(null);
  const [codexModelsLoading, setCodexModelsLoading] = useState(false);
  const codexSeq = useRef(0);
  const readCodexModels = useCallback(
    async (key: string, id: ProfileId, refresh: boolean): Promise<void> => {
      const seq = ++codexSeq.current;
      setCodexModelsLoading(true);
      try {
        const result = await dispatch("aiProviders:codexModels", { profileId: id, refresh });
        if (seq !== codexSeq.current) return;
        setCodexModels((prev) =>
          result.ok
            ? { key, models: result.value.models, error: null }
            : // A failed refresh keeps the list already shown; only its error is new.
              { key, models: prev?.key === key ? prev.models : [], error: result.error.message }
        );
      } catch (cause) {
        if (seq !== codexSeq.current) return;
        setCodexModels((prev) => ({
          key,
          models: prev?.key === key ? prev.models : [],
          error: cause instanceof Error ? cause.message : String(cause)
        }));
      } finally {
        if (seq === codexSeq.current) setCodexModelsLoading(false);
      }
    },
    []
  );
  useEffect(() => {
    if (codexKey === null || profileId === null) return;
    void readCodexModels(codexKey, profileId, false);
    return () => {
      codexSeq.current += 1;
    };
  }, [codexKey, profileId, readCodexModels]);

  const liveCodex = codexModels !== null && codexModels.key === codexKey ? codexModels : null;
  const acpLoading = probeIds.some((id) => ai.acpModelsLoadingIds.includes(id));
  const refreshing = codexModelsLoading || acpLoading;

  return (
    <SettingsSectionStack
      aria-label="AI feature settings"
      paneId="ai-features"
      {...(props.focusSection === undefined ? {} : { focusSection: props.focusSection })}
    >
      <SettingsPanelHead
        eyebrow="AI"
        title="AI Features"
        help="What each AI feature runs on, and the guidance it carries. Choices belong to the profile picked here; providers are set up under AI Providers."
        action={
          <>
            <AiProfilePicker {...props.profile} />
            {profileId === null ? null : (
              <button
                aria-busy={refreshing}
                aria-disabled={refreshing}
                className="settings-button"
                type="button"
                onClick={() => {
                  if (refreshing) return;
                  if (codexKey !== null) void readCodexModels(codexKey, profileId, true);
                  for (const id of probeIds) void fetchAcpModels(id, true);
                }}
              >
                <RefreshGlyph />
                {refreshing ? "Refreshing…" : "Refresh models"}
              </button>
            )}
          </>
        }
      />
      {profileId === null ? (
        <p className="settings-empty">AI settings belong to a profile. Add one under Profiles first.</p>
      ) : (
        <>
          {ai.settingsError !== null && (
            <p className="settings-field__error" role="alert">
              {ai.settings === null
                ? `AI settings couldn’t be read: ${ai.settingsError}`
                : ai.settingsError}
            </p>
          )}
          <SettingsSection
            sectionId="default-agents"
            title={AI_FEATURE_SECTION_LABELS["default-agents"]}
            eyebrow="Features"
            description="The provider, model and reasoning each feature starts with. Default leaves the choice to the provider."
          >
            {AI_JOB_IDS.map((jobId) => (
              <JobDefaultRow
                key={jobId}
                jobId={jobId}
                codexModels={liveCodex?.models ?? null}
                codexModelsError={
                  resolved === null && codexSnapshot !== null
                    ? "No usable Codex was found, so its models can’t be listed."
                    : (liveCodex?.error ?? null)
                }
                codexModelsLoading={codexModelsLoading && liveCodex === null}
              />
            ))}
          </SettingsSection>
          <GuidanceSection />
        </>
      )}
    </SettingsSectionStack>
  );
}

function modelLabel(model: CodexModelOption): string {
  return model.displayName.length > 0 ? model.displayName : model.id;
}

function codexEfforts(model: CodexModelOption | undefined): string[] {
  const advertised = model?.supportedReasoningEfforts.filter(isAiReasoningEffort) ?? [];
  return advertised.length > 0 ? advertised : [...AI_REASONING_EFFORTS];
}

/** The two thinking states an ACP agent honors; `acpReasoningEffort` in main
 *  collapses anything else onto these at spawn. */
const ACP_REASONING_CHOICES = [
  { value: "low", label: "Fast" },
  { value: "high", label: "Thinking" }
] as const;

const LOADING = "__loading__";

function JobDefaultRow(props: {
  jobId: AiJobId;
  /** Null until Codex's list has been read for the binary that runs. */
  codexModels: readonly CodexModelOption[] | null;
  codexModelsError: string | null;
  codexModelsLoading: boolean;
}) {
  const ai = useAiProvidersContext();
  const { settings, update, acpDiscovery, acpModels, acpModelErrors, acpModelsLoadingIds } = ai;
  const job = AI_JOBS[props.jobId];
  const value = settings?.jobs[props.jobId] ?? {};
  const [error, setError] = useState<string | null>(null);

  // The select shows the provider that will RUN — `effectiveJobProvider`, the
  // same answer main resolves — not a stored string naming an agent that has
  // since been switched off.
  const provider: AiProviderId =
    settings === null ? "codex" : effectiveJobProvider(settings, props.jobId);
  const isAcp = provider !== "codex";
  const providerOptions: AiProviderId[] = [
    "codex",
    ...(job.acp ? (settings?.acp.enabledAgentIds ?? []) : [])
  ];
  const providerLabel = (id: AiProviderId): string =>
    id === "codex"
      ? aiProviderDisplayName(id)
      : (acpDiscovery?.agents.find((agent) => agent.id === id)?.displayName ??
        aiProviderDisplayName(id));

  const patch = useCallback(
    (next: NonNullable<NonNullable<AiProviderSettingsPatch["jobs"]>[AiJobId]>) => {
      setError(null);
      void update({ jobs: { [props.jobId]: next } }).then(setError);
    },
    [props.jobId, update]
  );

  // ---- Model ----
  const modelValue = value.model ?? "";
  const acpList = isAcp ? acpModels[provider] : undefined;
  const modelLoading = isAcp
    ? acpModelsLoadingIds.includes(provider) || acpList === undefined
    : props.codexModelsLoading;
  const visibleCodex = (props.codexModels ?? []).filter((model) => !model.hidden);
  const choices: Array<{ id: string; label: string; isDefault: boolean }> = isAcp
    ? (acpList ?? []).map((model) => ({
        id: model.id,
        label: model.label,
        isDefault: model.isDefault === true
      }))
    : visibleCodex.map((model) => ({
        id: model.id,
        label: modelLabel(model),
        isDefault: model.isDefault
      }));
  const defaultModel = choices.find((choice) => choice.isDefault);
  const modelInChoices = choices.some((choice) => choice.id === modelValue);
  // A model the running provider's live list does not carry is left over from
  // another provider or a retired release. Shown as Default — and cleared, so
  // the value stored is the value shown is the value that runs. Only against a
  // list that actually loaded: an empty one may be a failed read.
  const liveIds = isAcp
    ? (acpList ?? []).map((model) => model.id)
    : (props.codexModels ?? []).map((model) => model.id);
  const staleModel = !modelLoading && liveIds.length > 0 && modelValue !== "" && !liveIds.includes(modelValue);

  // ---- Reasoning ----
  const reasoningValue = isAiReasoningEffort(value.reasoning) ? value.reasoning : "";
  const selectedCodexModel =
    props.codexModels?.find((model) => model.id === modelValue) ??
    props.codexModels?.find((model) => model.isDefault);
  const liveEfforts = selectedCodexModel?.supportedReasoningEfforts.filter(isAiReasoningEffort) ?? [];
  const efforts = codexEfforts(selectedCodexModel);
  const reasoningChoices: ReadonlyArray<{ value: string; label: string }> = isAcp
    ? ACP_REASONING_CHOICES
    : (reasoningValue !== "" && !efforts.includes(reasoningValue) && liveEfforts.length === 0
        ? [...efforts, reasoningValue]
        : efforts
      ).map((effort) => ({ value: effort, label: effort }));
  // An agent is handed "low" or "high" whatever is stored, so show that rather
  // than a blank select over a Codex "medium".
  const reasoningSelectValue = isAcp
    ? reasoningValue === "" || reasoningValue === "low"
      ? reasoningValue
      : "high"
    : reasoningChoices.some((choice) => choice.value === reasoningValue)
      ? reasoningValue
      : "";
  const staleReasoning =
    !isAcp &&
    !props.codexModelsLoading &&
    liveEfforts.length > 0 &&
    reasoningValue !== "" &&
    !liveEfforts.includes(reasoningValue);
  const codexDefaultEffort =
    selectedCodexModel !== undefined &&
    isAiReasoningEffort(selectedCodexModel.defaultReasoningEffort) &&
    efforts.includes(selectedCodexModel.defaultReasoningEffort)
      ? selectedCodexModel.defaultReasoningEffort
      : undefined;

  // Each normalization writes once per stale value, never in a loop.
  const normalized = useRef<string | null>(null);
  useEffect(() => {
    if (!staleModel && !staleReasoning) return;
    const key = `${provider}|${modelValue}|${reasoningValue}`;
    if (normalized.current === key) return;
    normalized.current = key;
    patch({ ...(staleModel ? { model: "" } : {}), ...(staleReasoning ? { reasoning: "" } : {}) });
  }, [staleModel, staleReasoning, provider, modelValue, reasoningValue, patch]);

  const modelError = isAcp ? acpModelErrors[provider] : props.codexModelsError;
  const unavailable = settings === null;
  const blocked = ai.saving;

  return (
    <SettingsField
      label={job.label}
      sub={job.description}
      control={
        <div className="settings-ai-job">
          <label className="settings-ai-job__field">
            <span className="settings-inline-field__label">Provider</span>
            <select
              aria-label={`${job.label} provider`}
              aria-disabled={blocked}
              className="settings-select"
              // One option is not a choice. Unavailable rather than in-flight,
              // so `disabled` is right here.
              disabled={unavailable || providerOptions.length === 1}
              value={provider}
              onChange={(event) => {
                if (blocked) return;
                const next = event.target.value;
                if (!isAiProviderId(next)) return;
                patch({ provider: next === "codex" ? "" : next, model: "", reasoning: "" });
              }}
            >
              {providerOptions.map((id) => (
                <option key={id} value={id}>
                  {providerLabel(id)}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-ai-job__field">
            <span className="settings-inline-field__label">Model</span>
            <select
              aria-label={`${job.label} model`}
              aria-disabled={blocked}
              className="settings-select"
              disabled={unavailable || modelLoading}
              value={modelLoading ? LOADING : modelInChoices ? modelValue : ""}
              onChange={(event) => {
                if (blocked) return;
                const next = event.target.value;
                if (isAcp) {
                  patch({ model: next });
                  return;
                }
                const nextModel =
                  props.codexModels?.find((model) => model.id === next) ??
                  (next === "" ? props.codexModels?.find((model) => model.isDefault) : undefined);
                patch({
                  model: next,
                  // An effort the new model does not take would be sent anyway.
                  ...(reasoningValue !== "" && !codexEfforts(nextModel).includes(reasoningValue)
                    ? { reasoning: "" }
                    : {})
                });
              }}
            >
              {modelLoading ? (
                <option value={LOADING}>Loading…</option>
              ) : (
                <>
                  <option value="">
                    {defaultModel === undefined ? "Default" : `Default (${defaultModel.label})`}
                  </option>
                  {choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
          <label className="settings-ai-job__field">
            <span className="settings-inline-field__label">Reasoning</span>
            <select
              aria-label={`${job.label} reasoning effort`}
              aria-disabled={blocked}
              className="settings-select"
              disabled={unavailable}
              value={reasoningSelectValue}
              onChange={(event) => {
                if (blocked) return;
                const next = event.target.value;
                if (next !== "" && !isAiReasoningEffort(next)) return;
                patch({ reasoning: next });
              }}
            >
              <option value="">
                {!isAcp && codexDefaultEffort !== undefined ? `Default (${codexDefaultEffort})` : "Default"}
              </option>
              {reasoningChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      }
      {...(!job.acp && job.acpUnavailableReason !== undefined
        ? { help: job.acpUnavailableReason }
        : {})}
      {...(error !== null
        ? { error }
        : modelError !== null && modelError !== undefined
          ? { error: `${providerLabel(provider)} models unavailable: ${modelError}` }
          : {})}
    />
  );
}

/**
 * Free-form guidance added to every feature's instructions. Saved on blur,
 * not per keystroke: each save is a settings write and a broadcast to every
 * window, and a half-typed sentence is not a preference.
 */
function GuidanceSection() {
  const { settings, update, profileId } = useAiProvidersContext();
  const saved = settings?.guidance ?? "";
  const [draft, setDraft] = useState(saved);
  const [state, setState] = useState<{ phase: "idle" } | { phase: "saved" } | { phase: "error"; message: string }>({
    phase: "idle"
  });

  // Follow the stored value when it changes elsewhere, and when the profile
  // does — a draft typed for one profile must not be saved to the next.
  useEffect(() => {
    setDraft(saved);
  }, [saved, profileId]);

  const save = (): void => {
    if (settings === null || draft === saved) return;
    void update({ guidance: draft }).then((message) =>
      setState(message === null ? { phase: "saved" } : { phase: "error", message })
    );
  };

  return (
    <SettingsSection
      sectionId="guidance"
      title={AI_FEATURE_SECTION_LABELS.guidance}
      eyebrow="Features"
      description="Preferences added to every feature’s instructions: tone, what to emphasize, what to leave out. Guidance steers a feature; it never gives one a permission it lacks."
    >
      <div className="settings-ai-guidance">
        <textarea
          aria-describedby="settings-ai-guidance-count"
          aria-label="Guidance for every AI feature"
          className="settings-input settings-ai-guidance__input"
          disabled={settings === null}
          maxLength={AI_GUIDANCE_MAX_LENGTH}
          placeholder="For example: keep explanations short, and call out anything that rewrites a published commit."
          rows={5}
          value={draft}
          onBlur={save}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setState({ phase: "idle" });
          }}
        />
        <div className="settings-ai-guidance__meta">
          <span id="settings-ai-guidance-count">
            {draft.length} / {AI_GUIDANCE_MAX_LENGTH}
          </span>
          <span aria-live="polite" role="status">
            {state.phase === "saved" ? "Saved" : draft !== saved ? "Saves when you leave the field" : ""}
          </span>
        </div>
        {state.phase === "error" && (
          <p className="settings-field__error" role="alert">
            {state.message}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
