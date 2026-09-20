import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_JOB_IDS,
  AI_JOBS,
  executablePathExample,
  normalizeManualExecutablePath,
  type AcpAgentDiscoveryEntry,
  type AiProviderId,
  type BuiltInAcpAgentId,
  type CodexAuthProfileList,
  type CodexAuthState,
  type CodexCandidate,
  type CodexCandidateSource
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { AiProfilePicker, type AiProfileSelection } from "./AiProfilePicker";
import { useAiProvidersContext, useInUseAcpModelProbes } from "./AiProvidersContext";
import { aiProviderChipTone, routedJobs, type AiProviderStatus } from "./ai-provider-status";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  SettingsSegmented,
  settingsChipClass,
  type SettingsFocusRequest
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

/**
 * Settings → AI Providers: the agents PwrGit can hand work to, one card per
 * provider. Ported from PwrSnap's `AIProvidersPage`, reshaped to PwrGit's rule
 * that a nav child is a card, not a screen (settings/AGENTS.md).
 *
 * Not Local Agents. That pane governs agents calling INTO PwrGit over MCP;
 * this one configures the agents PwrGit calls OUT to. The two share the word
 * "agent" and nothing else, which is why neither is called "Agents".
 *
 * Per profile: the head's picker chooses whose settings every card shows,
 * because a work profile and a personal one usually sign in to different
 * Codex accounts. Status comes from `AiProvidersContext`, the same read the
 * nav's dots render, so a card and its dot cannot disagree.
 */
export function AiProvidersSettings(props: {
  profile: AiProfileSelection;
  focusSection?: SettingsFocusRequest;
  /** Opens AI Features on its Default agents card. */
  onEditDefaults: () => void;
}) {
  const ai = useAiProvidersContext();
  const { request } = ai;
  useEffect(() => request(), [request]);
  const probeIds = useInUseAcpModelProbes();
  const checking = ai.codexSnapshotLoading || ai.acpDiscoveryLoading;

  const head = (
    <SettingsPanelHead
      eyebrow="AI"
      title="AI Providers"
      help="The agents PwrGit can hand work to, such as reviewing a rebase plan. Each profile keeps its own choices. For agents that call into PwrGit, see Local Agents."
      action={
        <>
          <AiProfilePicker {...props.profile} />
          {ai.profileId === null ? null : (
            <button
              aria-busy={checking}
              aria-disabled={checking}
              className="settings-button"
              type="button"
              onClick={() => {
                if (checking) return;
                void ai.refreshCodexSnapshot(true);
                void ai.refreshAcpDiscovery(true);
                for (const id of probeIds) void ai.fetchAcpModels(id, true);
              }}
            >
              <RefreshGlyph />
              {checking ? "Checking…" : "Re-check"}
            </button>
          )}
        </>
      }
    />
  );

  return (
    <SettingsSectionStack
      aria-label="AI provider settings"
      paneId="ai-providers"
      {...(props.focusSection === undefined ? {} : { focusSection: props.focusSection })}
    >
      {head}
      {ai.profileId === null ? (
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
          {/* The pane's one live region, for the reason Forges has one: a chip
              inside a disclosure header's `role="button"` is presentational
              and never announced. */}
          <p aria-live="polite" className="a11y-sr-only" role="status">
            {ai.statuses
              .map((status) => status.sentence)
              .filter((line) => line !== undefined)
              .join(". ")}
          </p>
          {ai.statuses.map((status) =>
            status.sub === "codex" ? (
              <CodexSection key={status.sub} status={status} onEditDefaults={props.onEditDefaults} />
            ) : (
              <AcpAgentSection
                key={status.sub}
                id={status.sub}
                status={status}
                onEditDefaults={props.onEditDefaults}
              />
            )
          )}
        </>
      )}
    </SettingsSectionStack>
  );
}

/** The card header's chip, from the same status the nav row reads. */
function statusChip(status: AiProviderStatus) {
  return {
    chip: <span aria-label={`${status.label}: ${status.badge}`}>{status.badge}</span>,
    chipKind: aiProviderChipTone(status.tone)
  };
}

/**
 * Which features run on this provider. Computed through `effectiveJobProvider`,
 * not the stored string, so the Codex card claims the jobs that fall back to
 * it — and an agent card says why a job it cannot take is not listed, rather
 * than leaving an enabled agent looking forgotten.
 */
function DefaultForField(props: { provider: AiProviderId; onEditDefaults: () => void }) {
  const { settings } = useAiProvidersContext();
  const jobs = routedJobs(settings, props.provider);
  const refused =
    props.provider === "codex" ? [] : AI_JOB_IDS.filter((jobId) => !AI_JOBS[jobId].acp);
  return (
    <SettingsField
      label="Default for"
      sub="Features that run on this provider."
      control={
        <div className="settings-field__actions">
          <span className="settings-ai-jobs">
            {jobs.length === 0 ? "No feature" : jobs.map((jobId) => AI_JOBS[jobId].label).join(", ")}
          </span>
          <button className="settings-inline-button" type="button" onClick={props.onEditDefaults}>
            Edit defaults
          </button>
        </div>
      }
      {...(refused.length === 0
        ? {}
        : {
            help: refused.map((jobId) => (
              <span key={jobId}>
                {AI_JOBS[jobId].label}: {AI_JOBS[jobId].acpUnavailableReason}
              </span>
            ))
          })}
    />
  );
}

// ---- Codex ------------------------------------------------------------------

const CODEX_SOURCE_LABELS: Record<CodexCandidateSource, string> = {
  env: "PWRDRVR_CODEX_COMMAND",
  config: "pinned",
  path: "PATH",
  application: "app install"
};

function CodexSection(props: { status: AiProviderStatus; onEditDefaults: () => void }) {
  const ai = useAiProvidersContext();
  const { settings, codexSnapshot: snapshot, update } = ai;
  const resolved = snapshot?.resolvedPath ?? null;
  const unavailable = settings === null;

  const pin = useCallback(
    (path: string) => update({ codex: { mode: "pinned", pinnedPath: path } }),
    [update]
  );

  return (
    <SettingsSection
      sectionId="codex"
      title={props.status.label}
      eyebrow="Provider"
      description={props.status.meta}
      {...statusChip(props.status)}
    >
      <DefaultForField provider="codex" onEditDefaults={props.onEditDefaults} />
      <SettingsField
        label="Selection"
        sub="Newest found follows the newest usable Codex on this machine. Specified path runs one binary for as long as it works."
        control={
          <SettingsSegmented
            aria-label="Codex selection"
            disabled={unavailable}
            options={[
              { value: "auto", label: "Newest found" },
              { value: "pinned", label: "Specified path" }
            ]}
            value={settings?.codex.mode ?? "auto"}
            onChange={(mode) => {
              if (ai.saving || settings === null || mode === settings.codex.mode) return;
              // Specifying with nothing pinned pins what runs now, so the
              // choice has something to hold on to.
              void update({
                codex: {
                  mode,
                  ...(mode === "pinned" && settings.codex.pinnedPath === "" && resolved !== null
                    ? { pinnedPath: resolved }
                    : {})
                }
              });
            }}
          />
        }
      />
      <SettingsField
        label="Installs"
        sub="Found on this machine. Using marks the binary the next job runs."
        control={
          <CodexInstalls
            candidates={snapshot?.candidates}
            loading={ai.codexSnapshotLoading}
            resolved={resolved}
            blocked={unavailable || ai.saving}
            onPin={pin}
          />
        }
        {...(ai.codexError === null ? {} : { error: `Codex discovery failed: ${ai.codexError}` })}
      />
      <SettingsField
        label="Custom path"
        sub="A Codex binary discovery does not find."
        control={
          <ManualPathInput
            executable="codex"
            label="Custom Codex path"
            saved={settings?.codex.mode === "pinned" ? settings.codex.pinnedPath : ""}
            saveLabel="Use path"
            disabled={unavailable}
            onSave={pin}
            onClear={() => update({ codex: { mode: "auto", pinnedPath: "" } })}
          />
        }
      />
      <CodexAccountField />
    </SettingsSection>
  );
}

function CodexInstalls(props: {
  candidates: readonly CodexCandidate[] | undefined;
  loading: boolean;
  resolved: string | null;
  blocked: boolean;
  onPin: (path: string) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  // The path ellipsises, so the full string has to stay readable — through a
  // card, never a native `title` (lib/AGENTS.md).
  const tip = useViewportTooltip();
  if (props.candidates === undefined) {
    return <p className="settings-empty">{props.loading ? "Looking for Codex…" : "Not checked yet."}</p>;
  }
  if (props.candidates.length === 0) {
    return (
      <p className="settings-empty">
        No Codex found. Install the Codex app or CLI, then Re-check — or give its path below.
      </p>
    );
  }
  return (
    <>
      <ul className="settings-ai-installs" aria-label="Codex installs">
        {props.candidates.map((candidate) => {
          const using = candidate.path === props.resolved;
          const meta = [
            CODEX_SOURCE_LABELS[candidate.source],
            candidate.version === null ? null : `v${candidate.version}`,
            candidate.available ? null : (candidate.failureReason ?? "unavailable")
          ]
            .filter((part) => part !== null)
            .join(" · ");
          return (
            <li key={candidate.path} className={`settings-ai-install${using ? " is-using" : ""}`}>
              <span className="settings-ai-install__body">
                <span className="settings-ai-install__path" {...hoverTooltip(tip, candidate.path)}>
                  {candidate.path}
                </span>
                <span className="settings-ai-install__meta">{meta}</span>
              </span>
              {using ? (
                <span className={settingsChipClass("ok")}>Using</span>
              ) : (
                <button
                  aria-disabled={props.blocked}
                  aria-label={`Use ${candidate.path}`}
                  className="settings-inline-button"
                  // Genuinely unusable, not in-flight: a binary that fails its
                  // probe is not something to pin.
                  disabled={!candidate.available}
                  type="button"
                  onClick={() => {
                    if (props.blocked) return;
                    setError(null);
                    void props.onPin(candidate.path).then(setError);
                  }}
                >
                  Use
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error !== null && (
        <p className="settings-field__error" role="alert">
          {error}
        </p>
      )}
      {tip.tooltipNode}
    </>
  );
}

/** What `aiProviders:codexAuthProfiles` answered, for the profile it asked. */
type AuthProfilesRead = { profileId: string; list: CodexAuthProfileList | null; error: string | null };

type LoginState =
  | { phase: "idle" }
  | { phase: "waiting" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

/** The select's value for "follow the profile". A colon cannot appear in a
 *  Codex profile name, so this can never collide with a real one. */
const FOLLOW = ":follow";

/**
 * Which Codex account this profile signs in with, and the way to sign in.
 *
 * "Follow profile" is the default and usually right: it resolves to a Codex
 * auth profile named like this PwrGit profile when one is signed in, so two
 * PwrGit profiles named after two Codex accounts need no setup at all.
 */
function CodexAccountField() {
  const ai = useAiProvidersContext();
  const { profileId, settings, codexSnapshot: snapshot, update, refreshCodexSnapshot } = ai;
  const [read, setRead] = useState<AuthProfilesRead | null>(null);
  const [login, setLogin] = useState<LoginState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const readProfiles = useCallback(async (): Promise<void> => {
    if (profileId === null) return;
    const seq = ++requestSeq.current;
    try {
      const result = await dispatch("aiProviders:codexAuthProfiles", { profileId });
      if (seq !== requestSeq.current) return;
      setRead(
        result.ok
          ? { profileId, list: result.value, error: null }
          : { profileId, list: null, error: result.error.message }
      );
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setRead({ profileId, list: null, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [profileId]);

  useEffect(() => {
    setLogin({ phase: "idle" });
    void readProfiles();
    return () => {
      requestSeq.current += 1;
    };
  }, [readProfiles]);

  const list = read?.profileId === profileId ? read.list : null;
  const listError = read?.profileId === profileId ? (read.error ?? read.list?.error ?? null) : null;
  const configured = settings?.codex.authProfile;
  const value = configured === undefined ? FOLLOW : configured;
  const followedLabel =
    list === null
      ? null
      : (list.profiles.find((option) => option.name === list.followed)?.displayName ?? list.followed);
  const auth = snapshot?.auth ?? null;
  const canSignIn = snapshot !== null && snapshot.resolvedPath !== null && profileId !== null;
  const waiting = login.phase === "waiting";
  const fieldError = login.phase === "error" ? login.message : (error ?? listError);

  const signIn = async (): Promise<void> => {
    if (waiting || profileId === null) return;
    setLogin({ phase: "waiting" });
    try {
      const result = await dispatch("aiProviders:codexLogin", { profileId });
      if (!result.ok) {
        setLogin({ phase: "error", message: result.error.message });
        return;
      }
      const { authenticated, started, detail } = result.value;
      setLogin(
        authenticated === true
          ? { phase: "done", message: "Signed in." }
          : started
            ? { phase: "done", message: "Finish signing in in your browser, then Re-check." }
            : { phase: "error", message: detail ?? "Codex didn’t start a sign-in." }
      );
      void refreshCodexSnapshot(true);
      void readProfiles();
    } catch (cause) {
      setLogin({ phase: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <SettingsField
      label="Account"
      sub="The Codex sign-in this profile uses. Follow profile picks a Codex profile with this profile’s name when one is signed in."
      control={
        <div className="settings-ai-account">
          <select
            aria-label="Codex account"
            className="settings-select"
            disabled={settings === null || list === null}
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              setError(null);
              void update({ codex: { authProfile: next === FOLLOW ? null : next } }).then(setError);
            }}
          >
            <option value={FOLLOW}>
              {followedLabel === null ? "Follow profile" : `Follow profile (${followedLabel})`}
            </option>
            {(list?.profiles ?? []).map((option) => (
              <option key={option.name} value={option.name}>
                {option.displayName}
                {option.email !== undefined
                  ? ` — ${option.email}`
                  : option.hasAuthFile
                    ? ""
                    : " — not signed in"}
              </option>
            ))}
            {/* A configured name the list does not carry (yet) still has to be
                the selected value, or the select would show the wrong one. */}
            {configured !== undefined &&
            list !== null &&
            !list.profiles.some((option) => option.name === configured) ? (
              <option value={configured}>{configured === "" ? "System default" : configured}</option>
            ) : null}
          </select>
          <div className="settings-field__actions">
            <span className="settings-ai-account__state">{authSummary(auth)}</span>
            <button
              aria-busy={waiting}
              aria-disabled={waiting}
              className="settings-inline-button"
              disabled={!canSignIn}
              type="button"
              onClick={() => void signIn()}
            >
              {waiting ? "Signing in…" : auth?.status === "authenticated" ? "Sign in again…" : "Sign in…"}
            </button>
          </div>
        </div>
      }
      help={
        login.phase === "done" ? login.message : canSignIn ? undefined : "Signing in needs a Codex install."
      }
      {...(fieldError === null ? {} : { error: fieldError })}
    />
  );
}

function authSummary(auth: CodexAuthState | null): string {
  if (auth === null) return "Sign-in not checked";
  const who = auth.profileLabel;
  if (auth.status === "authenticated") {
    const account = auth.email ?? "signed in";
    return `${account}${auth.planType === undefined ? "" : ` · ${auth.planType}`} (${who})`;
  }
  if (auth.status === "unauthenticated") return `Not signed in (${who})`;
  return `Sign-in check failed (${who})${auth.detail === undefined ? "" : `: ${auth.detail}`}`;
}

// ---- ACP agents -------------------------------------------------------------

function AcpAgentSection(props: {
  id: BuiltInAcpAgentId;
  status: AiProviderStatus;
  onEditDefaults: () => void;
}) {
  const ai = useAiProvidersContext();
  const { id, status } = props;
  const { settings, update } = ai;
  const entry = ai.acpDiscovery?.agents.find((agent) => agent.id === id);
  const enabled = settings?.acp.enabledAgentIds.includes(id) ?? false;
  const pref = settings?.acp.agents[id];
  const [error, setError] = useState<string | null>(null);

  const setEnabled = (next: boolean): Promise<string | null> => {
    const current = settings?.acp.enabledAgentIds ?? [];
    const enabledAgentIds = next
      ? [...new Set([...current, id])]
      : current.filter((agentId) => agentId !== id);
    return update({ acp: { enabledAgentIds } });
  };

  return (
    <SettingsSection
      sectionId={id}
      title={status.label}
      eyebrow="ACP agent"
      description={status.meta}
      {...statusChip(status)}
    >
      <SettingsField
        label="Use in PwrGit"
        sub="Off until you turn it on. An enabled agent can be chosen for features that accept ACP agents."
        control={
          <SettingsSwitch
            checked={enabled}
            // Unavailable, not in-flight: there is nothing to enable until an
            // install is found or a path is given. Turning one OFF always works.
            disabled={settings === null || (!enabled && entry?.installed !== true)}
            busy={ai.saving}
            label={`Use ${status.label} in PwrGit`}
            onChange={(next) => {
              if (ai.saving) return;
              setError(null);
              void setEnabled(next).then(setError);
            }}
          />
        }
        {...(entry !== undefined && !entry.installed && entry.detail !== undefined
          ? { help: entry.detail }
          : {})}
        {...(error === null ? {} : { error })}
      />
      <DefaultForField provider={id} onEditDefaults={props.onEditDefaults} />
      <SettingsField
        label="Installs"
        sub="Found on this machine. Choose one to always use it; choose it again to go back to the first found."
        control={
          <AcpInstalls
            entry={entry}
            pinned={pref?.selectedPath ?? ""}
            loading={ai.acpDiscoveryLoading}
            blocked={settings === null || ai.saving}
            onPick={(command) => update({ acp: { agents: { [id]: { selectedPath: command } } } })}
          />
        }
        {...(ai.acpDiscoveryError === null
          ? {}
          : { error: `Agent discovery failed: ${ai.acpDiscoveryError}` })}
      />
      <SettingsField
        label="Custom path"
        sub="Wins over every install found, for as long as it passes the probe."
        control={
          <ManualPathInput
            executable={id}
            label={`Custom ${status.label} path`}
            saved={pref?.overridePath ?? ""}
            saveLabel={entry?.installed === true || enabled ? "Save" : "Save & enable"}
            disabled={settings === null}
            onSave={(path) =>
              update({
                acp: {
                  agents: { [id]: { overridePath: path } },
                  ...(entry?.installed === true || enabled
                    ? {}
                    : { enabledAgentIds: [...(settings?.acp.enabledAgentIds ?? []), id] })
                }
              })
            }
            onClear={() => update({ acp: { agents: { [id]: { overridePath: "" } } } })}
          />
        }
      />
      {enabled && entry?.installed === true ? <AcpSessionCheck id={id} label={status.label} /> : null}
    </SettingsSection>
  );
}

function AcpInstalls(props: {
  entry: AcpAgentDiscoveryEntry | undefined;
  /** The install the operator pinned, or "" for the first found. */
  pinned: string;
  loading: boolean;
  blocked: boolean;
  onPick: (command: string) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const tip = useViewportTooltip();
  const { entry } = props;
  if (entry === undefined) {
    return <p className="settings-empty">{props.loading ? "Looking for installs…" : "Not checked yet."}</p>;
  }
  if (entry.instances.length === 0) {
    return <p className="settings-empty">No install found.</p>;
  }
  return (
    <>
      <ul className="settings-ai-installs" aria-label={`${entry.displayName} installs`}>
        {entry.instances.map((instance) => {
          const active = instance.command === entry.activeCommand;
          const pinned = props.pinned !== "" && instance.command === props.pinned;
          const meta = [
            instance.version === undefined ? null : `v${instance.version}`,
            instance.source === "override"
              ? "custom path"
              : instance.source === "fallback"
                ? "well-known path"
                : "PATH"
          ]
            .filter((part) => part !== null)
            .join(" · ");
          return (
            <li key={instance.command} className={`settings-ai-install${active ? " is-using" : ""}`}>
              <span className="settings-ai-install__body">
                <span className="settings-ai-install__path" {...hoverTooltip(tip, instance.command)}>
                  {instance.command}
                </span>
                <span className="settings-ai-install__meta">{meta}</span>
              </span>
              {active ? <span className={settingsChipClass("ok")}>Using</span> : null}
              {/* A custom path is set and cleared in its own field; pinning
                  it here too would be a second way to say the same thing.
                  An install in use only because it was found first has
                  nothing to unpin, so it offers nothing. */}
              {instance.source === "override" || (active && !pinned) ? null : (
                <button
                  aria-disabled={props.blocked}
                  aria-label={pinned ? `Stop pinning ${instance.command}` : `Use ${instance.command}`}
                  className="settings-inline-button"
                  type="button"
                  onClick={() => {
                    if (props.blocked) return;
                    setError(null);
                    void props.onPick(pinned ? "" : instance.command).then(setError);
                  }}
                >
                  {pinned ? "Unpin" : "Use"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error !== null && (
        <p className="settings-field__error" role="alert">
          {error}
        </p>
      )}
      {tip.tooltipNode}
    </>
  );
}

/**
 * Start the agent and ask for its models — the handshake a job makes first.
 * Install discovery only proves a binary answers `--version`; a signed-out
 * agent passes that and fails the first real job, which is the failure this
 * turns into a card state before anything depends on it.
 */
function AcpSessionCheck(props: { id: BuiltInAcpAgentId; label: string }) {
  const { acpModels, acpModelErrors, acpModelsLoadingIds, fetchAcpModels } = useAiProvidersContext();
  const loading = acpModelsLoadingIds.includes(props.id);
  const models = acpModels[props.id];
  const failure = acpModelErrors[props.id];
  const result = loading
    ? `Starting ${props.label}…`
    : failure !== undefined
      ? null
      : models === undefined
        ? "Not checked yet."
        : `Session started · ${models.length} model${models.length === 1 ? "" : "s"} offered`;
  return (
    <SettingsField
      label="Session"
      sub="Starts the agent and asks for its models, the same handshake a job makes."
      control={
        <div className="settings-field__actions">
          <button
            aria-busy={loading}
            aria-disabled={loading}
            className="settings-inline-button"
            type="button"
            onClick={() => {
              if (loading) return;
              void fetchAcpModels(props.id, true);
            }}
          >
            {loading ? "Checking…" : "Check session"}
          </button>
          {result === null ? null : <span className="settings-ai-jobs">{result}</span>}
        </div>
      }
      {...(failure === undefined || loading ? {} : { error: failure })}
    />
  );
}

// ---- Shared -----------------------------------------------------------------

/**
 * A path field with its own Save and Clear. The draft follows the saved value
 * when it changes elsewhere (another window, a pin), and is checked against
 * the absolute-path rule before anything is sent — main enforces the same rule
 * and would otherwise drop the path without saying why.
 */
function ManualPathInput(props: {
  executable: string;
  label: string;
  saved: string;
  saveLabel: string;
  disabled: boolean;
  onSave: (path: string) => Promise<string | null>;
  onClear: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(props.saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const platform = window.pwrgit.platform;

  useEffect(() => {
    setDraft(props.saved);
  }, [props.saved]);

  const trimmed = draft.trim();
  const dirty = trimmed.length > 0 && trimmed !== props.saved;

  const run = async (action: () => Promise<string | null>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setError(await action());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-ai-path">
      <div className="settings-field__actions">
        <input
          aria-invalid={error !== null}
          aria-label={props.label}
          className="settings-input settings-ai-path__input"
          disabled={props.disabled}
          // "e.g.", because a bare example path reads as the value — and for
          // Codex it is often the very install already in use.
          placeholder={`e.g. ${executablePathExample(platform, props.executable)}`}
          spellCheck={false}
          type="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
        />
        <button
          aria-busy={busy}
          aria-disabled={busy || !dirty}
          className="settings-inline-button"
          disabled={props.disabled}
          type="button"
          onClick={() => {
            if (busy || !dirty) return;
            const normalized = normalizeManualExecutablePath(platform, draft);
            if (!normalized.ok) {
              setError(normalized.error);
              return;
            }
            void run(() => props.onSave(normalized.path));
          }}
        >
          {busy ? "Saving…" : props.saveLabel}
        </button>
        <button
          aria-disabled={busy || (props.saved === "" && draft === "")}
          className="settings-inline-button"
          disabled={props.disabled}
          type="button"
          onClick={() => {
            if (busy || (props.saved === "" && draft === "")) return;
            setDraft("");
            if (props.saved !== "") void run(props.onClear);
          }}
        >
          Clear
        </button>
      </div>
      {error !== null && (
        <p className="settings-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
