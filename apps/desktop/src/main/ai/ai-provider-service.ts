// The one owner of "which agents does this profile have, and which one does
// a job run on". Settings reads it to render AI Providers and AI Features;
// an agent-driven feature calls `resolveJob` to get the backend, model and
// effort it should run with, instead of discovering on its own.
//
// Ported from the discovery half of PwrSnap's settings store
// (`desktop-settings-store.ts`: installed-agent discovery is store-owned and
// served from cache) plus its `acp:discover` / `acp:models` / `codex:models`
// handlers. Two PwrGit differences:
//
// - Everything is per profile. A profile's settings pick the Codex binary, the
//   account it signs in with, and the enabled agents, so discovery results
//   are cached by those inputs — two profiles with identical inputs share one
//   probe, and changing an input is a cache miss with no invalidation step.
// - There is no long-lived agent pool, so model listing starts a short-lived
//   process and the result is cached in memory and on disk.
//
// Discovery is read-only: Codex is probed with `--version` and
// `login status`, ACP agents with `--version` / `--help`. Only model listing
// starts an agent for real.

import { join } from "node:path";
import {
  CodexLoginManager,
  checkCodexAuthStatus,
  discoverCodexAuthProfiles,
  discoverCodexCommands,
  resolveCodexHomeForProfile,
  type CodexAuthProfileDiscoverySnapshot,
  type CodexAuthStatusResponse,
  type CodexDiscoverySnapshot,
  type CodexProfileLoginResponse,
  type DiscoverCodexCommandsParams,
  type StartCodexLoginParams
} from "@pwrdrvr/codex-discovery";
import {
  discoverLocalAcpAgentInstances,
  type AcpAgentStrategy,
  type DiscoveredAcpAgent,
  type DiscoveredAcpAgentGroup,
  type LocalAcpDiscoveryOptions
} from "@pwrdrvr/agent-acp";
import {
  AI_JOBS,
  aiProviderDisplayName,
  effectiveJobProvider,
  err,
  isAiModelId,
  ok,
  type AcpAgentDiscovery,
  type AcpAgentModelList,
  type AcpAgentModelOption,
  type AiCodexSettings,
  type AiJobId,
  type AiProviderSettings,
  type BuiltInAcpAgentId,
  type CodexAuthProfileList,
  type CodexLoginResult,
  type CodexModelList,
  type CodexModelOption,
  type CodexProviderDiscovery,
  type ProfileId,
  type PwrGitError,
  type Result
} from "@pwrgit/shared";
import { acpReasoningEffort } from "./acp-effort";
import {
  acpDiscoveryOptionsForInstallScan,
  pwrgitAcpStrategy
} from "./acp-enabled-discovery";
import { resolveActiveAcpInstance } from "./acp-instance-resolver";
import { listAcpModels, type AcpModelLister } from "./acp-model-client";
import type { AcpModelCache } from "./acp-model-cache";
import {
  agentEnvForPwrGitProfile,
  codexEnvForProfile,
  openExternal,
  PWRGIT_AGENT_PROFILE_ENV,
  toAgentKitLogger
} from "./agent-kit-bindings";
import { agentErrorMessage } from "./agent-error-message";
import {
  selectedCodexCandidate,
  toAcpDiscovery,
  toAcpInstances,
  toCodexAuthState,
  toCodexCandidates
} from "./ai-provider-discovery";
import type { AiProviderSettingsStore } from "./ai-provider-settings";
import { listCodexModels, type CodexModelLister } from "./codex-model-client";
import { codexModelCacheKey, type CodexModelCache } from "./codex-model-cache";

/** How long a discovery answer is served without re-probing. Settings'
 *  Refresh bypasses it; this only bounds how stale an unrefreshed answer gets,
 *  so a CLI installed while PwrGit runs is noticed without a click. */
const DISCOVERY_MAX_AGE_MS = 5 * 60_000;

/** The CODEX_HOME a profile's Codex runs under, and whose auth it is. */
export type CodexEnvironment = {
  env: NodeJS.ProcessEnv;
  codexHome: string;
  /** "" for the System default. */
  authProfile: string;
};

/**
 * The backend a job runs on, ready to spawn.
 *
 * `env` is complete — the profile's CODEX_HOME and `PWRGIT_PROFILE_ID` are
 * already applied — so a consumer passes it through rather than rebuilding it.
 */
export type ResolvedAgentBackend =
  | {
      kind: "codex";
      providerId: "codex";
      displayName: string;
      command: string;
      version?: string;
      env: NodeJS.ProcessEnv;
      codexHome: string;
      authProfile: string;
    }
  | {
      kind: "acp";
      providerId: BuiltInAcpAgentId;
      displayName: string;
      strategy: AcpAgentStrategy;
      /** Command, args and env the kit's ACP clients take. */
      agent: DiscoveredAcpAgent;
      env: NodeJS.ProcessEnv;
    };

export type ResolvedAgentJob = {
  profileId: ProfileId;
  jobId: AiJobId;
  backend: ResolvedAgentBackend;
  /** Null means the backend's own default. */
  model: string | null;
  /** The model's display name when a cached list knows it. */
  modelLabel: string | null;
  /** Null means the backend's own default. Already collapsed to Fast/Thinking
   *  (`low` / `high`) for an ACP backend. */
  effort: string | null;
  /** The profile's guidance, for the job to add to its instructions. */
  guidance: string;
};

export type AiProviderServiceDependencies = {
  settings: Pick<AiProviderSettingsStore, "read">;
  discoverCodex: (params: DiscoverCodexCommandsParams) => Promise<CodexDiscoverySnapshot>;
  checkCodexAuth: (params: {
    command: string;
    codexHome: string;
    profile: string;
    signal?: AbortSignal;
  }) => Promise<CodexAuthStatusResponse>;
  discoverAcp: (options: LocalAcpDiscoveryOptions) => Promise<DiscoveredAcpAgentGroup[]>;
  listCodexModels: CodexModelLister;
  listAcpModels: AcpModelLister;
  listCodexAuthProfiles: (options: {
    configuredProfile?: string;
    env?: NodeJS.ProcessEnv;
  }) => CodexAuthProfileDiscoverySnapshot;
  startCodexLogin: (params: StartCodexLoginParams) => Promise<CodexProfileLoginResponse>;
  environmentFor: (profileId: ProfileId, codex: AiCodexSettings) => CodexEnvironment;
  acpModelCache: Pick<AcpModelCache, "load" | "save">;
  codexModelCache: Pick<CodexModelCache, "load" | "save" | "findLabel">;
  /** Scratch space for ACP model-listing sessions — never a repository. */
  scratchDir: string;
  now: () => number;
  maxAgeMs: number;
  /** Development E2E seam: answer "nothing installed" without probing this
   *  machine. Packaged builds never set it. */
  discoveryDisabled: boolean;
  /** Called by `dispose` — the production wiring kills login children here. */
  onDispose?: () => void;
};

/**
 * The Codex environment for a profile. An explicit auth profile wins; absent,
 * the profile follows `agentEnvForPwrGitProfile` — a signed-in Codex profile
 * of the same name, else the System default — the same rule the agent
 * session applies, so Settings names the account a job will actually use.
 */
export function codexEnvironmentFor(
  profileId: ProfileId,
  codex: AiCodexSettings,
  baseEnv: NodeJS.ProcessEnv = process.env
): CodexEnvironment {
  if (codex.authProfile === undefined) {
    const env = agentEnvForPwrGitProfile(profileId, baseEnv);
    const codexHome = env["CODEX_HOME"] ?? "";
    const named = resolveCodexHomeForProfile(profileId, { env: baseEnv });
    return { env, codexHome, authProfile: codexHome === named ? profileId : "" };
  }
  const authProfile = codex.authProfile;
  const env: NodeJS.ProcessEnv = {
    ...codexEnvForProfile(authProfile === "" ? undefined : authProfile, baseEnv),
    [PWRGIT_AGENT_PROFILE_ENV]: profileId
  };
  return { env, codexHome: env["CODEX_HOME"] ?? "", authProfile };
}

function authProfileLabel(name: string): string {
  return name === "" ? "System default" : name;
}

function agentError(code: string, message: string, cause?: unknown): PwrGitError {
  return cause === undefined
    ? { kind: "agent", code, message }
    : { kind: "agent", code, message, cause };
}

function abortError(): DOMException {
  return new DOMException("Agent provider request cancelled", "AbortError");
}

/** Wait for shared work without letting one caller's cancel stop it for the
 *  others who joined it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      }
    );
  });
}

/**
 * What probing Codex found. Cached, and shared by every profile whose inputs
 * match — so it deliberately carries no environment: the env holds the
 * caller's `PWRGIT_PROFILE_ID`, and a cached one would hand the first
 * profile's id to every job after it.
 */
type CodexProbe = {
  discovery: CodexProviderDiscovery;
  selected: { command: string; version?: string } | null;
};

/** A probe joined with the asking profile's own environment. */
type CodexResolution = CodexProbe & { environment: CodexEnvironment };

type Cached<T> = { at: number; value: T };

/**
 * A small cache in front of one kind of discovery: answers younger than
 * `maxAgeMs` are served, concurrent asks for the same key share one run, and
 * `force` always starts fresh (or joins a run already in flight, which is as
 * fresh as a new one would be).
 */
class DiscoveryCache<T> {
  private readonly values = new Map<string, Cached<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly now: () => number,
    private readonly maxAgeMs: number
  ) {}

  get(key: string, force: boolean, run: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const cached = this.values.get(key);
    if (!force && cached !== undefined && this.now() - cached.at < this.maxAgeMs) {
      return Promise.resolve(cached.value);
    }
    const started = run().then(
      (value) => {
        this.values.set(key, { at: this.now(), value });
        return value;
      }
    );
    const tracked = started.finally(() => {
      if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }

  forget(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
    this.inFlight.clear();
  }
}

export class AiProviderService {
  private readonly deps: AiProviderServiceDependencies;
  private readonly codex: DiscoveryCache<CodexProbe>;
  private readonly acp: DiscoveryCache<DiscoveredAcpAgentGroup[]>;
  private readonly codexModelLists = new Map<string, CodexModelOption[]>();
  private readonly codexModelsInFlight = new Map<string, Promise<CodexModelOption[]>>();
  private readonly acpModelLists = new Map<string, AcpAgentModelOption[]>();
  private readonly acpModelsInFlight = new Map<string, Promise<AcpAgentModelOption[]>>();
  /** Aborted on dispose, so a probe in flight at quit stops instead of
   *  holding the process open. */
  private readonly lifetime = new AbortController();

  constructor(deps: AiProviderServiceDependencies) {
    this.deps = deps;
    this.codex = new DiscoveryCache(deps.now, deps.maxAgeMs);
    this.acp = new DiscoveryCache(deps.now, deps.maxAgeMs);
  }

  settings(profileId: ProfileId): AiProviderSettings {
    return this.deps.settings.read(profileId);
  }

  // ---- Discovery ------------------------------------------------------------

  async discoverCodex(
    profileId: ProfileId,
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<CodexProviderDiscovery> {
    const resolution = await this.codexResolution(
      this.settings(profileId),
      profileId,
      options.force === true,
      options.signal
    );
    return resolution.discovery;
  }

  async discoverAcp(
    profileId: ProfileId,
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<AcpAgentDiscovery> {
    const settings = this.settings(profileId);
    const groups = await this.acpGroups(
      settings,
      profileId,
      options.force === true,
      options.signal
    );
    // Mapped per call, not cached: which install is active depends on the
    // pinned path, which is a preference, not a discovery input.
    return toAcpDiscovery(groups, settings.acp.agents);
  }

  // ---- Models -------------------------------------------------------------

  async codexModels(
    profileId: ProfileId,
    options: { refresh?: boolean } = {}
  ): Promise<Result<CodexModelList, PwrGitError>> {
    const resolution = await this.codexResolution(this.settings(profileId), profileId, false);
    if (resolution.selected === null) {
      return err(agentError("codex_unavailable", "No usable Codex CLI was found."));
    }
    const { command } = resolution.selected;
    const key = codexModelCacheKey(command, resolution.environment.codexHome);
    if (options.refresh !== true) {
      // Empty is never a hit, for the reason the ACP path gives below: it
      // would shadow a re-probe that might now succeed.
      const memory = this.codexModelLists.get(key);
      if (memory !== undefined && memory.length > 0) return ok({ models: memory });
      const persisted = this.deps.codexModelCache.load(key);
      if (persisted !== undefined && persisted.models.length > 0) {
        this.codexModelLists.set(key, persisted.models);
        return ok({ models: persisted.models });
      }
    }
    try {
      let listing = this.codexModelsInFlight.get(key);
      if (listing === undefined) {
        listing = this.deps.listCodexModels({
          command,
          env: resolution.environment.env,
          includeHidden: false
        });
        this.codexModelsInFlight.set(key, listing);
      }
      let models: CodexModelOption[];
      try {
        models = await listing;
      } finally {
        if (this.codexModelsInFlight.get(key) === listing) this.codexModelsInFlight.delete(key);
      }
      this.codexModelLists.set(key, models);
      if (models.length > 0) {
        this.deps.codexModelCache.save(key, {
          models,
          discoveredAt: new Date(this.deps.now()).toISOString()
        });
      }
      return ok({ models });
    } catch (cause) {
      return err(agentError("codex_models_failed", agentErrorMessage(cause), cause));
    }
  }

  async acpModels(
    profileId: ProfileId,
    agentId: BuiltInAcpAgentId,
    options: { refresh?: boolean } = {}
  ): Promise<Result<AcpAgentModelList, PwrGitError>> {
    const settings = this.settings(profileId);
    // A disabled agent is never started — not even to list its models.
    if (!settings.acp.enabledAgentIds.includes(agentId)) return ok({ agentId, models: [] });
    const strategy = pwrgitAcpStrategy(agentId);
    if (strategy === undefined) {
      return err(agentError("acp_unknown_agent", `Unknown ACP agent ${agentId}.`));
    }
    let groups: DiscoveredAcpAgentGroup[];
    try {
      groups = await this.acpGroups(settings, profileId, false);
    } catch (cause) {
      return err(agentError("acp_discovery_failed", agentErrorMessage(cause), cause));
    }
    const group = groups.find((candidate) => candidate.strategyId === agentId);
    // Not installed: nothing to list, and the picker falls back to Default.
    if (group === undefined || group.instances.length === 0) return ok({ agentId, models: [] });
    const active = resolveActiveAcpInstance(toAcpInstances(group), settings.acp.agents[agentId]);
    const key = JSON.stringify([agentId, active.command]);
    if (options.refresh !== true) {
      const memory = this.acpModelLists.get(key);
      if (memory !== undefined && memory.length > 0) return ok({ agentId, models: memory });
      const persisted = this.deps.acpModelCache.load(agentId);
      // An empty or other-install list is never a hit: it would shadow a
      // re-probe that might now succeed.
      if (
        persisted !== undefined &&
        persisted.command === active.command &&
        persisted.models.length > 0
      ) {
        this.acpModelLists.set(key, persisted.models);
        return ok({ agentId, models: persisted.models });
      }
    }
    try {
      let listing = this.acpModelsInFlight.get(key);
      if (listing === undefined) {
        const environment = this.deps.environmentFor(profileId, settings.codex);
        listing = this.deps.listAcpModels({
          strategy,
          command: active.command,
          args: group.args,
          env: { ...environment.env, ...group.env },
          cwd: join(this.deps.scratchDir, "acp-models", agentId)
        });
        this.acpModelsInFlight.set(key, listing);
      }
      let models: AcpAgentModelOption[];
      try {
        models = await listing;
      } finally {
        if (this.acpModelsInFlight.get(key) === listing) this.acpModelsInFlight.delete(key);
      }
      this.acpModelLists.set(key, models);
      // Only a list with something in it is persisted — an empty answer is
      // not a hit on the way back in, so saving it would erase a good list
      // and buy nothing.
      if (models.length > 0) {
        this.deps.acpModelCache.save(agentId, {
          models,
          command: active.command,
          discoveredAt: new Date(this.deps.now()).toISOString()
        });
      }
      return ok({ agentId, models });
    } catch (cause) {
      return err(agentError("acp_models_failed", agentErrorMessage(cause), cause));
    }
  }

  // ---- Codex accounts -----------------------------------------------------

  codexAuthProfiles(profileId: ProfileId): CodexAuthProfileList {
    const settings = this.settings(profileId);
    const environment = this.deps.environmentFor(profileId, settings.codex);
    const followed = this.deps.environmentFor(profileId, {
      mode: settings.codex.mode,
      pinnedPath: settings.codex.pinnedPath
    }).authProfile;
    const snapshot = this.deps.listCodexAuthProfiles({
      configuredProfile: environment.authProfile,
      env: process.env
    });
    return {
      profiles: snapshot.profiles
        // A configured name with no directory yet is listed by the kit so it
        // can be created; offering it here would be a choice with no account.
        // The System default always stays: it is where `codex login` signs in
        // when nothing else is chosen, whether or not it has run yet.
        .filter(
          (profile) =>
            profile.exists || profile.name === "" || profile.name === environment.authProfile
        )
        .map((profile) => ({
          name: profile.name,
          displayName: profile.displayName,
          codexHome: profile.codexHome,
          hasAuthFile: profile.hasAuthFile,
          ...(profile.accountEmail !== undefined ? { email: profile.accountEmail } : {})
        })),
      followed,
      ...(snapshot.error !== undefined ? { error: snapshot.error } : {})
    };
  }

  /** Start `codex login` for the account this profile resolves to. The next
   *  discovery re-checks sign-in rather than serving the cached answer. */
  async codexLogin(profileId: ProfileId): Promise<Result<CodexLoginResult, PwrGitError>> {
    const settings = this.settings(profileId);
    const resolution = await this.codexResolution(settings, profileId, false);
    if (resolution.selected === null) {
      return err(agentError("codex_unavailable", "No usable Codex CLI was found."));
    }
    const { environment } = resolution;
    this.codex.forget(this.codexKey(settings, environment));
    try {
      const response = await this.deps.startCodexLogin({
        codexHome: environment.codexHome,
        command: resolution.selected.command,
        profile: environment.authProfile
      });
      return ok({
        profile: environment.authProfile,
        started: response.started,
        ...(response.authenticated !== undefined ? { authenticated: response.authenticated } : {}),
        ...(response.detail !== undefined ? { detail: response.detail } : {})
      });
    } catch (cause) {
      return err(agentError("codex_login_failed", agentErrorMessage(cause), cause));
    }
  }

  // ---- Jobs ---------------------------------------------------------------

  /**
   * The backend, model and effort `jobId` runs with for this profile.
   *
   * Mirrors what Settings shows: the provider comes from
   * `effectiveJobProvider`, so a job whose chosen agent was disabled, or that
   * cannot run on ACP at all, lands on Codex exactly as its row says. Never
   * spawns an agent — discovery only — and answers from cache unless
   * `refresh`. Answers `disabled` without probing while the profile's AI
   * switch is off, which it is until the operator turns it on.
   */
  async resolveJob(input: {
    profileId: ProfileId;
    jobId: AiJobId;
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<Result<ResolvedAgentJob, PwrGitError>> {
    const { profileId, jobId } = input;
    const settings = this.settings(profileId);
    // Checked before anything is probed: while the switch is off, a job
    // resolves to nothing and spawns nothing.
    if (!settings.enabled) {
      return err(
        agentError(
          "disabled",
          "AI features are off for this profile. Turn them on from the AI switch at the bottom of the sidebar."
        )
      );
    }
    const job = settings.jobs[jobId];
    const providerId = effectiveJobProvider(settings, jobId);
    const model = isAiModelId(job.model) ? job.model : null;
    const base = { profileId, jobId, guidance: settings.guidance };
    try {
      if (providerId === "codex") {
        const resolution = await this.codexResolution(
          settings,
          profileId,
          input.refresh === true,
          input.signal
        );
        if (resolution.selected === null) {
          return err(
            agentError(
              "unavailable",
              `${AI_JOBS[jobId].label} needs Codex, and no usable Codex CLI was found.`
            )
          );
        }
        if (resolution.discovery.auth?.status === "unauthenticated") {
          return err(
            agentError(
              "signed_out",
              `Codex is not signed in for ${authProfileLabel(resolution.environment.authProfile)}.`
            )
          );
        }
        return ok({
          ...base,
          backend: {
            kind: "codex",
            providerId: "codex",
            displayName: aiProviderDisplayName("codex"),
            command: resolution.selected.command,
            ...(resolution.selected.version !== undefined
              ? { version: resolution.selected.version }
              : {}),
            env: resolution.environment.env,
            codexHome: resolution.environment.codexHome,
            authProfile: resolution.environment.authProfile
          },
          model,
          modelLabel: model === null ? null : (this.deps.codexModelCache.findLabel(model) ?? null),
          effort: job.reasoning ?? null
        });
      }

      const strategy = pwrgitAcpStrategy(providerId);
      const groups = await this.acpGroups(
        settings,
        profileId,
        input.refresh === true,
        input.signal
      );
      const group = groups.find((candidate) => candidate.strategyId === providerId);
      const displayName = aiProviderDisplayName(providerId);
      if (strategy === undefined || group === undefined || group.instances.length === 0) {
        return err(agentError("unavailable", `${displayName} is enabled but not installed.`));
      }
      const active = resolveActiveAcpInstance(toAcpInstances(group), settings.acp.agents[providerId]);
      const environment = this.deps.environmentFor(profileId, settings.codex);
      const label =
        model === null
          ? null
          : (this.acpModelLists.get(JSON.stringify([providerId, active.command]))?.find(
              (option) => option.id === model
            )?.label ?? null);
      return ok({
        ...base,
        backend: {
          kind: "acp",
          providerId,
          displayName,
          strategy,
          agent: {
            strategyId: group.strategyId,
            backendId: group.backendId,
            name: group.name,
            command: active.command,
            args: group.args,
            env: group.env,
            discoveredAt: group.discoveredAt,
            ...(active.version !== undefined ? { version: active.version } : {})
          },
          env: { ...environment.env, ...group.env }
        },
        model,
        modelLabel: label,
        effort: job.reasoning === undefined ? null : acpReasoningEffort(job.reasoning)
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return err(agentError("cancelled", "Agent discovery was cancelled."));
      }
      return err(agentError("discovery_failed", agentErrorMessage(cause), cause));
    }
  }

  /** Stop in-flight probes and drop every cached answer. */
  dispose(): void {
    this.lifetime.abort();
    this.codex.clear();
    this.acp.clear();
    this.deps.onDispose?.();
  }

  // ---- Internals ----------------------------------------------------------

  private codexKey(settings: AiProviderSettings, environment: CodexEnvironment): string {
    return JSON.stringify([
      settings.codex.mode,
      settings.codex.mode === "pinned" ? settings.codex.pinnedPath : "",
      environment.codexHome,
      environment.authProfile
    ]);
  }

  private async codexResolution(
    settings: AiProviderSettings,
    profileId: ProfileId,
    force: boolean,
    signal?: AbortSignal
  ): Promise<CodexResolution> {
    const environment = this.deps.environmentFor(profileId, settings.codex);
    const key = this.codexKey(settings, environment);
    const probe = await untilAborted(
      this.codex.get(key, force, () => this.probeCodex(settings, environment)),
      signal
    );
    return { ...probe, environment };
  }

  /** Probes with `environment`, but returns nothing of it: the key already
   *  pins everything in it that changes the answer (CODEX_HOME, the account). */
  private async probeCodex(
    settings: AiProviderSettings,
    environment: CodexEnvironment
  ): Promise<CodexProbe> {
    const refreshedAt = new Date(this.deps.now()).toISOString();
    if (this.deps.discoveryDisabled) {
      return {
        discovery: { candidates: [], resolvedPath: null, auth: null, refreshedAt },
        selected: null
      };
    }
    const pinned = settings.codex.pinnedPath.trim();
    const snapshot = await this.deps.discoverCodex({
      env: environment.env,
      signal: this.lifetime.signal,
      ...(settings.codex.mode === "pinned" && pinned.length > 0
        ? { configuredCommand: pinned }
        : {})
    });
    const selected = selectedCodexCandidate(snapshot);
    const auth =
      selected === null
        ? null
        : toCodexAuthState(
            await this.deps.checkCodexAuth({
              command: selected.command,
              codexHome: environment.codexHome,
              profile: environment.authProfile,
              signal: this.lifetime.signal
            }),
            authProfileLabel(environment.authProfile)
          );
    return {
      discovery: {
        candidates: toCodexCandidates(snapshot),
        resolvedPath: selected?.command ?? null,
        auth,
        refreshedAt
      },
      selected
    };
  }

  private acpGroups(
    settings: AiProviderSettings,
    profileId: ProfileId,
    force: boolean,
    signal?: AbortSignal
  ): Promise<DiscoveredAcpAgentGroup[]> {
    const environment = this.deps.environmentFor(profileId, settings.codex);
    const options = acpDiscoveryOptionsForInstallScan(settings, environment.env);
    // The inputs that change what the scan finds: the override paths it is
    // allowed to try. Enablement matters only through them.
    const key = JSON.stringify(Object.entries(options.overrides ?? {}).sort());
    return untilAborted(
      this.acp.get(key, force, async () =>
        this.deps.discoveryDisabled
          ? []
          : this.deps.discoverAcp({ ...options, signal: this.lifetime.signal })
      ),
      signal
    );
  }
}

/** Production wiring: the agent kit's discovery, the short-lived listers, and
 *  one login manager whose children die with the service. */
export function createAiProviderService(options: {
  settings: Pick<AiProviderSettingsStore, "read">;
  acpModelCache: Pick<AcpModelCache, "load" | "save">;
  codexModelCache: Pick<CodexModelCache, "load" | "save" | "findLabel">;
  scratchDir: string;
  discoveryDisabled?: boolean;
}): AiProviderService {
  const logins = new CodexLoginManager({
    logger: toAgentKitLogger("ai:codex-login"),
    openExternal
  });
  return new AiProviderService({
    settings: options.settings,
    discoverCodex: (params) => discoverCodexCommands(params),
    checkCodexAuth: (params) => checkCodexAuthStatus(params),
    discoverAcp: (discovery) => discoverLocalAcpAgentInstances(discovery),
    listCodexModels,
    listAcpModels,
    listCodexAuthProfiles: (list) => discoverCodexAuthProfiles(list),
    startCodexLogin: (params) => logins.startProfileLogin(params),
    environmentFor: (profileId, codex) => codexEnvironmentFor(profileId, codex),
    acpModelCache: options.acpModelCache,
    codexModelCache: options.codexModelCache,
    scratchDir: options.scratchDir,
    now: () => Date.now(),
    maxAgeMs: DISCOVERY_MAX_AGE_MS,
    discoveryDisabled: options.discoveryDisabled ?? false,
    onDispose: () => logins.dispose()
  });
}
