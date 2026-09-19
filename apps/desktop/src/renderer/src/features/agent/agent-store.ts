import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentAvailability,
  AgentChoice,
  AgentEffort,
  AgentModelOption,
  AgentProviderAvailability
} from "@pwrgit/shared";
import { dispatch, windowProfileId } from "../../lib/pwrgit";

/**
 * What this window knows about its local agent: whether one is set up, which
 * models it offers, and the model and effort the operator picked from the
 * chip. A window belongs to one profile, so one store per window is enough.
 *
 * The choice lives in memory only. It applies to every request from this
 * window until PwrGit quits; persistent defaults belong to Settings.
 */
type AgentStoreState = {
  availability:
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; value: AgentAvailability }
    | { kind: "error"; message: string };
  models:
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; value: AgentModelOption[] }
    | { kind: "error"; message: string };
  choice: AgentChoice;
};

const INITIAL: AgentStoreState = {
  availability: { kind: "idle" },
  models: { kind: "idle" },
  choice: {}
};

let state: AgentStoreState = INITIAL;
const listeners = new Set<() => void>();

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
  state = INITIAL;
  for (const listener of listeners) listener();
}

export function loadAgentAvailability(refresh = false): void {
  const profileId = windowProfileId();
  if (profileId === null) return;
  if (!refresh && state.availability.kind !== "idle") return;
  set({ availability: { kind: "loading" } });
  void dispatch("agent:availability", {
    profileId,
    ...(refresh ? { refresh: true } : {})
  }).then((result) => {
    set({
      availability: result.ok
        ? { kind: "ready", value: result.value }
        : { kind: "error", message: result.error.message }
    });
  });
}

/** Models start the agent's app-server, so they load when first asked for. */
export function loadAgentModels(): void {
  const profileId = windowProfileId();
  if (profileId === null) return;
  if (state.models.kind === "loading" || state.models.kind === "ready") return;
  set({ models: { kind: "loading" } });
  void dispatch("agent:models", { profileId }).then((result) => {
    set({
      models: result.ok
        ? { kind: "ready", value: result.value.models }
        : { kind: "error", message: result.error.message }
    });
  });
}

export function setAgentChoice(patch: AgentChoice): void {
  set({ choice: { ...state.choice, ...patch } });
}

/** Back to the agent's default model. */
export function clearAgentModel(): void {
  const next: AgentChoice = {};
  if (state.choice.effort !== undefined) next.effort = state.choice.effort;
  set({ choice: next });
}

/** `undefined` is Auto: each task's own default effort. */
export function setAgentEffort(effort: AgentEffort | undefined): void {
  const next: AgentChoice = {};
  if (state.choice.model !== undefined) next.model = state.choice.model;
  if (effort !== undefined) next.effort = effort;
  set({ choice: next });
}

export type AgentView = {
  state: AgentStoreState;
  /** Codex's entry, when discovery has answered. */
  codex: AgentProviderAvailability | null;
  ready: boolean;
  /** "Codex" today; the name failure lines and footers use. */
  name: string;
};

/** Subscribe to the store and make sure availability has been asked for. */
export function useAgent(): AgentView {
  const current = useSyncExternalStore(subscribeStore, snapshot, snapshot);
  useEffect(() => {
    loadAgentAvailability();
  }, []);
  const availability =
    current.availability.kind === "ready" ? current.availability.value : null;
  const codex =
    availability?.providers.find((provider) => provider.id === "codex") ?? null;
  return {
    state: current,
    codex,
    ready: availability?.status === "ready",
    name: codex?.displayName ?? "Codex"
  };
}

/** The model a request will run on, as far as the renderer can tell. */
export function chosenModelLabel(view: AgentView, lastModel?: string): string | null {
  const chosen = view.state.choice.model;
  const models =
    view.state.models.kind === "ready" ? view.state.models.value : [];
  if (chosen !== undefined) {
    return models.find((model) => model.id === chosen)?.displayName ?? chosen;
  }
  if (lastModel !== undefined && lastModel !== "") return lastModel;
  return models.find((model) => model.isDefault)?.displayName ?? null;
}
