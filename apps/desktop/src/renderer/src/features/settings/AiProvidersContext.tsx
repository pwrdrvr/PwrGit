// Provider settings and discovery state shared by the Settings nav's AI
// Providers children and the two AI panes. Ported from PwrSnap's
// `AiProvidersContext.tsx`.
//
// Why one owner above the nav and the panes: the nav dots and the cards are
// two views of the same answer. With each owning a copy, a Refresh on the pane
// would move the cards and leave the nav stale — and a model probe failing
// would show "Unavailable" on a card under a green dot.
//
// Per profile. The Settings window is shared by every profile and these
// settings are not, so the provider is keyed by `profileId`: switching the
// profile the AI panes edit drops every answer read for the previous one.
//
// Nothing is probed until `request()` is called — by the nav when the AI
// Providers group unfolds, or by a pane on mount — so opening Settings on
// General does no discovery at all. Even then, reads are served from main's
// cache; only a pane's Refresh forces a re-probe.
//
// Model probes (`aiProviders:acpModels`) spawn the agent, so this provider
// never issues one on its own: the AI pages do, and it holds the results so
// the nav reflects a failure a page already found.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from "react";
import type {
  AcpAgentDiscovery,
  AcpAgentModelOption,
  AiProviderSettings,
  AiProviderSettingsPatch,
  BuiltInAcpAgentId,
  CodexProviderDiscovery,
  ProfileId
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  describeAiProviders,
  enabledAcpAgentIdsForModelProbes,
  type AiProviderStatus
} from "./ai-provider-status";

export type AiProvidersValue = {
  /** The profile these settings belong to; null until one is known. */
  profileId: ProfileId | null;
  settings: AiProviderSettings | null;
  settingsError: string | null;
  saving: boolean;
  /** Resolves to the failure message, or null once saved — so a field can put
   *  its own failure beside itself instead of at the top of the pane. */
  update: (patch: AiProviderSettingsPatch) => Promise<string | null>;
  /** Start the first (cache-served) discovery reads. Idempotent per profile. */
  request: () => void;
  codexSnapshot: CodexProviderDiscovery | null;
  codexSnapshotLoading: boolean;
  codexError: string | null;
  refreshCodexSnapshot: (force: boolean) => Promise<void>;
  acpDiscovery: AcpAgentDiscovery | null;
  acpDiscoveryLoading: boolean;
  acpDiscoveryError: string | null;
  refreshAcpDiscovery: (force: boolean) => Promise<void>;
  acpModels: Readonly<Record<string, readonly AcpAgentModelOption[]>>;
  acpModelErrors: Readonly<Record<string, string | undefined>>;
  acpModelsLoadingIds: readonly string[];
  fetchAcpModels: (agentId: BuiltInAcpAgentId, refresh?: boolean) => Promise<void>;
  /** Every provider's status, in nav order. */
  statuses: readonly AiProviderStatus[];
};

const AiProvidersContext = createContext<AiProvidersValue | null>(null);

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function AiProvidersProvider(props: {
  profileId: ProfileId | null;
  children: ReactNode;
}): ReactElement {
  const { profileId } = props;
  const [settings, setSettings] = useState<AiProviderSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** How many writes are in flight, not whether one is: two fields saving at
   *  once must not have the first to land clear the busy state for the
   *  second. `saving` is the boolean that falls out of it. */
  const [writesInFlight, setWritesInFlight] = useState(0);
  const saving = writesInFlight > 0;
  const [codexSnapshot, setCodexSnapshot] = useState<CodexProviderDiscovery | null>(null);
  const [codexSnapshotLoading, setCodexSnapshotLoading] = useState(true);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [acpDiscovery, setAcpDiscovery] = useState<AcpAgentDiscovery | null>(null);
  const [acpDiscoveryLoading, setAcpDiscoveryLoading] = useState(true);
  const [acpDiscoveryError, setAcpDiscoveryError] = useState<string | null>(null);
  const [acpModels, setAcpModels] = useState<Record<string, readonly AcpAgentModelOption[]>>({});
  const [acpModelErrors, setAcpModelErrors] = useState<Record<string, string | undefined>>({});
  const [acpModelsLoadingIds, setAcpModelsLoadingIds] = useState<readonly string[]>([]);

  /** The profile every in-flight answer is checked against, read at settle
   *  time: an answer for the profile the reader just switched away from must
   *  not paint over the new one's. */
  const profileRef = useRef(profileId);
  profileRef.current = profileId;

  // ---- Settings -------------------------------------------------------------

  useEffect(() => {
    setSettings(null);
    setSettingsError(null);
    if (profileId === null) return;
    let live = true;
    // Subscribed before the read, as `useForgeStatuses` does: a push is newer
    // than the read by definition, and one landing mid-read must not be
    // overwritten by it.
    let pushed = false;
    const unsubscribe = subscribe("aiProviders:changed", (snapshot) => {
      if (snapshot.profileId !== profileId) return;
      pushed = true;
      setSettings(snapshot.settings);
    });
    void dispatch("aiProviders:read", { profileId })
      .then((result) => {
        if (!live || pushed) return;
        if (result.ok) setSettings(result.value.settings);
        else setSettingsError(result.error.message);
      })
      .catch((cause: unknown) => {
        if (live) setSettingsError(message(cause));
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [profileId]);

  const update = useCallback(
    async (patch: AiProviderSettingsPatch): Promise<string | null> => {
      if (profileId === null) return "Choose a profile first.";
      setWritesInFlight((count) => count + 1);
      try {
        const result = await dispatch("aiProviders:update", { profileId, patch });
        if (!result.ok) return result.error.message;
        if (profileRef.current === profileId) {
          setSettings(result.value.settings);
          setSettingsError(null);
        }
        return null;
      } catch (cause) {
        return message(cause);
      } finally {
        setWritesInFlight((count) => count - 1);
      }
    },
    [profileId]
  );

  // ---- Discovery ------------------------------------------------------------

  // Last-issued-wins. Reads overlap routinely — a pin writes settings, which
  // re-reads below, while the pane asks for a forced one — and an older answer
  // settling last must not replace the newer one.
  const codexSeq = useRef(0);
  const refreshCodexSnapshot = useCallback(
    async (force: boolean): Promise<void> => {
      if (profileId === null) return;
      const seq = ++codexSeq.current;
      setCodexSnapshotLoading(true);
      try {
        const result = await dispatch("aiProviders:discoverCodex", { profileId, force });
        if (seq !== codexSeq.current) return;
        if (result.ok) {
          setCodexSnapshot(result.value);
          setCodexError(null);
        } else {
          setCodexError(result.error.message);
        }
      } catch (cause) {
        if (seq === codexSeq.current) setCodexError(message(cause));
      } finally {
        if (seq === codexSeq.current) setCodexSnapshotLoading(false);
      }
    },
    [profileId]
  );

  const acpSeq = useRef(0);
  const refreshAcpDiscovery = useCallback(
    async (force: boolean): Promise<void> => {
      if (profileId === null) return;
      const seq = ++acpSeq.current;
      setAcpDiscoveryLoading(true);
      try {
        const result = await dispatch("aiProviders:discoverAcp", { profileId, force });
        if (seq !== acpSeq.current) return;
        if (result.ok) {
          setAcpDiscovery(result.value);
          setAcpDiscoveryError(null);
        } else {
          setAcpDiscoveryError(result.error.message);
        }
      } catch (cause) {
        if (seq === acpSeq.current) setAcpDiscoveryError(message(cause));
      } finally {
        if (seq === acpSeq.current) setAcpDiscoveryLoading(false);
      }
    },
    [profileId]
  );

  // Per agent, last-issued-wins like the reads above.
  const acpModelsSeq = useRef<Record<string, number>>({});
  const fetchAcpModels = useCallback(
    async (agentId: BuiltInAcpAgentId, refresh = false): Promise<void> => {
      if (profileId === null) return;
      const seq = (acpModelsSeq.current[agentId] ?? 0) + 1;
      acpModelsSeq.current[agentId] = seq;
      setAcpModelsLoadingIds((ids) => (ids.includes(agentId) ? ids : [...ids, agentId]));
      let error: string | undefined;
      let models: readonly AcpAgentModelOption[] | undefined;
      try {
        const result = await dispatch("aiProviders:acpModels", { profileId, agentId, refresh });
        if (result.ok) models = result.value.models;
        else error = result.error.message;
      } catch (cause) {
        error = message(cause);
      }
      if (acpModelsSeq.current[agentId] !== seq) return;
      setAcpModelErrors((prev) => ({ ...prev, [agentId]: error }));
      setAcpModels((prev) => {
        if (models !== undefined) return { ...prev, [agentId]: models };
        // A FAILED probe must not blank a list already shown. Only the first
        // load falls back to `[]`, so the picker settles on "Default" instead
        // of sticking on "Loading…".
        return agentId in prev ? prev : { ...prev, [agentId]: [] };
      });
      setAcpModelsLoadingIds((ids) => ids.filter((id) => id !== agentId));
    },
    [profileId]
  );

  // A ref, not state: StrictMode's double-invoked effects and the nav and a
  // pane both calling `request()` in one commit must still read once.
  const requestedRef = useRef<ProfileId | null>(null);
  const request = useCallback((): void => {
    if (profileId === null || requestedRef.current === profileId) return;
    requestedRef.current = profileId;
    void refreshCodexSnapshot(false);
    void refreshAcpDiscovery(false);
  }, [profileId, refreshCodexSnapshot, refreshAcpDiscovery]);

  // A different profile: none of the previous one's answers apply. If it was
  // already requested, the reader is looking at AI state, so read again.
  const shownProfile = useRef(profileId);
  useEffect(() => {
    if (shownProfile.current === profileId) return;
    shownProfile.current = profileId;
    codexSeq.current += 1;
    acpSeq.current += 1;
    acpModelsSeq.current = {};
    setCodexSnapshot(null);
    setCodexError(null);
    setCodexSnapshotLoading(true);
    setAcpDiscovery(null);
    setAcpDiscoveryError(null);
    setAcpDiscoveryLoading(true);
    setAcpModels({});
    setAcpModelErrors({});
    setAcpModelsLoadingIds([]);
    if (requestedRef.current !== null) {
      requestedRef.current = null;
      request();
    }
  }, [profileId, request]);

  // Re-read when a setting discovery depends on changes — the Codex mode,
  // pinned path or account; an agent's enablement or paths. State that
  // outlives a pane has to ask. Still not forced: main caches by exactly these
  // inputs, so a changed input is a miss and everything else is served.
  const codexDepsKey =
    settings === null
      ? null
      : JSON.stringify([
          settings.codex.mode,
          settings.codex.pinnedPath,
          settings.codex.authProfile ?? null
        ]);
  const acpDepsKey =
    settings === null
      ? null
      : JSON.stringify([[...settings.acp.enabledAgentIds].sort(), settings.acp.agents]);
  const seenDeps = useRef<{ profile: ProfileId | null; codex: string | null; acp: string | null }>({
    profile: null,
    codex: null,
    acp: null
  });
  useEffect(() => {
    const seen = seenDeps.current;
    if (requestedRef.current === profileId && seen.profile === profileId) {
      if (seen.codex !== null && codexDepsKey !== null && seen.codex !== codexDepsKey) {
        void refreshCodexSnapshot(false);
      }
      if (seen.acp !== null && acpDepsKey !== null && seen.acp !== acpDepsKey) {
        void refreshAcpDiscovery(false);
      }
    }
    seenDeps.current = { profile: profileId, codex: codexDepsKey, acp: acpDepsKey };
  }, [profileId, codexDepsKey, acpDepsKey, refreshCodexSnapshot, refreshAcpDiscovery]);

  const enabledAgentIds = settings?.acp.enabledAgentIds;
  const statuses = useMemo(
    () =>
      describeAiProviders({
        codex: codexSnapshot,
        codexLoading: codexSnapshotLoading,
        acpDiscovery,
        acpDiscoveryLoading,
        enabledAgentIds: enabledAgentIds ?? [],
        acpModelErrors
      }),
    [
      codexSnapshot,
      codexSnapshotLoading,
      acpDiscovery,
      acpDiscoveryLoading,
      enabledAgentIds,
      acpModelErrors
    ]
  );

  const value = useMemo<AiProvidersValue>(
    () => ({
      profileId,
      settings,
      settingsError,
      saving,
      update,
      request,
      codexSnapshot,
      codexSnapshotLoading,
      codexError,
      refreshCodexSnapshot,
      acpDiscovery,
      acpDiscoveryLoading,
      acpDiscoveryError,
      refreshAcpDiscovery,
      acpModels,
      acpModelErrors,
      acpModelsLoadingIds,
      fetchAcpModels,
      statuses
    }),
    [
      profileId,
      settings,
      settingsError,
      saving,
      update,
      request,
      codexSnapshot,
      codexSnapshotLoading,
      codexError,
      refreshCodexSnapshot,
      acpDiscovery,
      acpDiscoveryLoading,
      acpDiscoveryError,
      refreshAcpDiscovery,
      acpModels,
      acpModelErrors,
      acpModelsLoadingIds,
      fetchAcpModels,
      statuses
    ]
  );

  return <AiProvidersContext.Provider value={value}>{props.children}</AiProvidersContext.Provider>;
}

/** Throws outside `<AiProvidersProvider>`: a silent "never loaded" default
 *  would render a nav of unknown dots forever instead of failing loudly. */
export function useAiProvidersContext(): AiProvidersValue {
  const value = useContext(AiProvidersContext);
  if (value === null) {
    throw new Error("useAiProvidersContext must be called within <AiProvidersProvider>");
  }
  return value;
}

/**
 * Probe the model list of every enabled agent a job is routed to, once per
 * profile, and return those agent ids (for a Refresh to re-probe).
 *
 * The first probe bypasses main's persisted model cache, so it doubles as the
 * runtime availability / sign-in check — without it a signed-out agent looks
 * usable until a job fails. Both AI pages call this: AI Features needs the
 * lists for its pickers, and AI Providers needs the result so a card's status
 * is honest on the page that lists it.
 */
export function useInUseAcpModelProbes(): readonly BuiltInAcpAgentId[] {
  const { settings, acpModels, acpModelsLoadingIds, fetchAcpModels } = useAiProvidersContext();
  const key = enabledAcpAgentIdsForModelProbes(settings).sort().join(",");
  const ids = useMemo(
    () => (key.length > 0 ? (key.split(",") as BuiltInAcpAgentId[]) : []),
    [key]
  );
  useEffect(() => {
    for (const id of ids) {
      if (acpModels[id] === undefined && !acpModelsLoadingIds.includes(id)) {
        void fetchAcpModels(id, true);
      }
    }
  }, [ids, acpModels, acpModelsLoadingIds, fetchAcpModels]);
  return ids;
}
