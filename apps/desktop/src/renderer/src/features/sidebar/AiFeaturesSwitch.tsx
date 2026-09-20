import { useEffect, useRef, useState } from "react";
import {
  jobProviders,
  type AcpAgentDiscovery,
  type AiProviderSettings,
  type CodexProviderDiscovery,
  type Profile
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { AiConsentDialog } from "../settings/AiConsentDialog";
import { firstUnreadyAiProvider, resolveAiToggleAction } from "../settings/ai-enablement";
import { SettingsSwitch } from "../settings/SettingsSwitch";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The window profile's AI switch, at the bottom of the sidebar — PwrGit's
 * version of the AI switch in PwrSnap's Library status bar. Off until the
 * operator turns it on; while it is off, main's `resolveJob` answers
 * `disabled` and no feature sends anything to an agent.
 *
 * Turning it on asks main about the providers the features run on first,
 * from cache, at the moment of the click — not on mount. A switch in every
 * window's sidebar that probed on render would start `codex` for every
 * profile window on every launch, which is exactly what "off by default" is
 * meant to rule out. A provider that cannot run sends the reader to AI
 * Providers instead; the first time, the disclosure comes before anything is
 * switched on.
 */
export function AiFeaturesSwitch(props: { profile: Profile }) {
  const profileId = props.profile.id;
  const [settings, setSettings] = useState<AiProviderSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Synchronous in-flight guard: `busy` is render state and a double click
   *  lands before it does. */
  const working = useRef(false);

  useEffect(() => {
    setSettings(null);
    setError(null);
    let live = true;
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
        else setError(result.error.message);
      })
      .catch((cause: unknown) => {
        if (live) setError(message(cause));
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [profileId]);

  const write = async (patch: { enabled: boolean; consentAcceptedAt?: string }): Promise<void> => {
    const result = await dispatch("aiProviders:update", { profileId, patch });
    if (result.ok) {
      setSettings(result.value.settings);
      setError(null);
    } else {
      setError(result.error.message);
    }
  };

  /** The readiness of the providers the features run on, from main's cache. */
  const readiness = async (current: AiProviderSettings) => {
    const providers = jobProviders(current);
    const [codex, acp] = await Promise.all([
      providers.includes("codex")
        ? dispatch("aiProviders:discoverCodex", { profileId })
        : Promise.resolve(null),
      providers.some((provider) => provider !== "codex")
        ? dispatch("aiProviders:discoverAcp", { profileId })
        : Promise.resolve(null)
    ]);
    const codexAnswer: CodexProviderDiscovery | null = codex?.ok === true ? codex.value : null;
    const acpAnswer: AcpAgentDiscovery | null = acp?.ok === true ? acp.value : null;
    return firstUnreadyAiProvider(current, codexAnswer, acpAnswer);
  };

  const toggle = async (): Promise<void> => {
    if (settings === null || working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const unready = settings.enabled ? null : await readiness(settings);
      const action = resolveAiToggleAction({
        enabled: settings.enabled,
        consentAcceptedAt: settings.consentAcceptedAt,
        providerReady: unready === undefined ? undefined : unready === null
      });
      if (action === "disable") await write({ enabled: false });
      else if (action === "enable") await write({ enabled: true });
      else if (action === "consent") setConsentOpen(true);
      else {
        const opened = await dispatch("settings:open", {
          page: "ai-providers",
          profileId,
          ...(unready === null || unready === undefined ? {} : { sub: unready })
        });
        if (!opened.ok) setError(opened.error.message);
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const on = settings?.enabled === true;
  return (
    <div className="sidebar__footer">
      <div className="ai-switch">
        <span aria-hidden="true" className="ai-switch__label">
          AI features
        </span>
        <SettingsSwitch
          checked={on}
          // Unavailable, not in-flight, until the settings have been read:
          // there is no state to flip yet.
          disabled={settings === null}
          busy={busy}
          label={`AI features for ${props.profile.name}`}
          onChange={() => void toggle()}
        />
      </div>
      {error !== null && (
        <p className="ai-switch__error" role="alert">
          {error}
        </p>
      )}
      {consentOpen && (
        <AiConsentDialog
          profileName={props.profile.name}
          onCancel={() => setConsentOpen(false)}
          onAccept={() => {
            setConsentOpen(false);
            void write({ enabled: true, consentAcceptedAt: new Date().toISOString() });
          }}
        />
      )}
    </div>
  );
}
