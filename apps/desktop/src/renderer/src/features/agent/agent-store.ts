import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentAvailability,
  AgentChoice,
  AgentJobStatus,
  AiFeaturesSettingsSub,
  AiJobId,
  CodexModelOption
} from "@pwrgit/shared";
import { dispatch, subscribe, windowProfileId } from "../../lib/pwrgit";

/**
 * What this window knows about its agent jobs: each job's answer from the AI
 * provider settings (ready, AI off, or why not), and the Codex models the chip
 * offers. A window belongs to one profile, so one store per window is enough.
 *
 * Nothing here decides anything. `agent:availability` asks main's resolver the
 * question a request asks, so a job the chip calls ready is one a request would
 * run, and a profile with AI off answers without probing anything. A settings
 * change for this profile (`aiProviders:changed`) asks again.
 */
type Load<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };

type AgentStoreState = {
  availability: Load<AgentAvailability>;
  models: Load<CodexModelOption[]>;
};

const INITIAL: AgentStoreState = {
  availability: { kind: "idle" },
  models: { kind: "idle" }
};

let state: AgentStoreState = INITIAL;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;
/** The latest request of each kind; an older answer landing late is dropped. */
let availabilityRequest = 0;
let modelsRequest = 0;

function set(patch: Partial<AgentStoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): AgentStoreState {
  return state;
}

/** Test seam: forget everything this window learned. */
export function resetAgentStore(): void {
  stopWatching?.();
  stopWatching = null;
  availabilityRequest += 1;
  modelsRequest += 1;
  state = INITIAL;
  for (const listener of listeners) listener();
}

/** Once per window: this profile's settings changed, so its answers may have. */
function watchSettings(): void {
  if (stopWatching !== null) return;
  stopWatching = subscribe("aiProviders:changed", (changed) => {
    if (changed.profileId !== windowProfileId()) return;
    // The Codex path or account may be what changed; the list is re-read on
    // the next open rather than now.
    modelsRequest += 1;
    set({ models: { kind: "idle" } });
    loadAgentAvailability({ reload: true });
  });
}

export function loadAgentAvailability(
  options: { refresh?: boolean; reload?: boolean } = {}
): void {
  const profileId = windowProfileId();
  if (profileId === null) return;
  const again = options.refresh === true || options.reload === true;
  if (!again && state.availability.kind !== "idle") return;
  const request = ++availabilityRequest;
  // A reload after a settings edit keeps the last answer on screen until the
  // new one lands, so typing guidance in Settings does not blink the chip.
  // "Check again" is asked for, so it says it is looking.
  if (options.refresh === true || state.availability.kind !== "ready") {
    set({ availability: { kind: "loading" } });
  }
  void dispatch("agent:availability", {
    profileId,
    ...(options.refresh === true ? { refresh: true } : {})
  }).then((result) => {
    if (request !== availabilityRequest) return;
    set({
      availability: result.ok
        ? { kind: "ready", value: result.value }
        : { kind: "error", message: result.error.message }
    });
  });
}

/** Listing models starts Codex's app-server, so they load when first asked for. */
export function loadAgentModels(): void {
  const profileId = windowProfileId();
  if (profileId === null) return;
  if (state.models.kind === "loading" || state.models.kind === "ready") return;
  const request = ++modelsRequest;
  set({ models: { kind: "loading" } });
  void dispatch("aiProviders:codexModels", { profileId }).then((result) => {
    if (request !== modelsRequest) return;
    set({
      models: result.ok
        ? { kind: "ready", value: result.value.models.filter((model) => !model.hidden) }
        : { kind: "error", message: result.error.message }
    });
  });
}

/**
 * Settings is where the defaults and the fixes live. It is one window shared
 * by every profile, so it is opened on this window's.
 */
export function openAiSettings(
  page: "ai-providers" | "ai-features",
  sub?: AiFeaturesSettingsSub
): void {
  const profileId = windowProfileId();
  void dispatch("settings:open", {
    page,
    ...(sub !== undefined ? { sub } : {}),
    ...(profileId !== null ? { profileId } : {})
  });
}

export type AgentView = {
  jobId: AiJobId;
  /** Main's answer for this job; null while it is being asked. */
  status: AgentJobStatus | null;
  loading: boolean;
  ready: boolean;
  /** AI is off for this profile: offer the non-AI path and say nothing. */
  off: boolean;
  /** Why the job cannot run, for a footer or the chip's menu. */
  reason: string | null;
  /** The provider's name for footers: "Codex". */
  name: string;
  models: AgentStoreState["models"];
};

function viewOf(current: AgentStoreState, jobId: AiJobId): AgentView {
  const availability = current.availability;
  const status = availability.kind === "ready" ? availability.value.jobs[jobId] : null;
  return {
    jobId,
    status,
    loading: availability.kind === "idle" || availability.kind === "loading",
    ready: status?.state === "ready",
    off: status?.state === "disabled",
    reason:
      availability.kind === "error"
        ? availability.message
        : status !== null && status.state !== "ready"
          ? status.message
          : null,
    name: status?.providerName ?? "Codex",
    models: current.models
  };
}

function useAvailabilityRequest(): void {
  useEffect(() => {
    if (windowProfileId() === null) return;
    watchSettings();
    loadAgentAvailability();
  }, []);
}

/** Subscribe to the store and make sure availability has been asked for. */
export function useAgent(jobId: AiJobId): AgentView {
  const current = useSyncExternalStore(subscribeStore, snapshot, snapshot);
  useAvailabilityRequest();
  return viewOf(current, jobId);
}

/**
 * Whether to offer a job's entry points at all: its answer is in and AI is on.
 * A job that is on but cannot run yet is still offered — its footer says why
 * and where to fix it. A boolean snapshot, so a caller as high as `App`
 * re-renders only when the answer flips, not on every store update.
 */
export function useAgentOffered(jobId: AiJobId): boolean {
  const offered = useSyncExternalStore(
    subscribeStore,
    () => {
      const view = viewOf(state, jobId);
      return !view.loading && !view.off;
    },
    () => false
  );
  useAvailabilityRequest();
  return offered;
}

/** The model a request will run on: this request's pick, else the Settings
 *  default, else what the last answer reported, else Codex's own default. */
export function chosenModelLabel(
  view: AgentView,
  choice: AgentChoice,
  lastModel?: string
): string | null {
  const models = view.models.kind === "ready" ? view.models.value : [];
  const named = (id: string): string | null =>
    models.find((model) => model.id === id)?.displayName ?? null;
  if (choice.model !== undefined) return named(choice.model) ?? choice.model;
  const configured = view.status?.model ?? null;
  if (configured !== null) {
    return view.status?.modelLabel ?? named(configured) ?? configured;
  }
  if (lastModel !== undefined && lastModel !== "") return lastModel;
  return models.find((model) => model.isDefault)?.displayName ?? null;
}
