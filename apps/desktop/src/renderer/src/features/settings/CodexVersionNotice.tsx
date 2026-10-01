import { useEffect, useRef, useState } from "react";
import { jobProviders, type AiProviderSettings, type CodexVersionAdvisory } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { CodexVersionHelp, codexVersionMessage } from "./CodexVersionHelp";

/** Probe only when this window's profile enables a feature routed to Codex.
 * Dismissal lasts for this launch; a different runtime can raise a new notice. */
export function CodexVersionNotice({ profileId }: { profileId: string | null }) {
  const [settings, setSettings] = useState<{ profileId: string; value: AiProviderSettings } | null>(null);
  const [notice, setNotice] = useState<{ profileId: string; advisory: CodexVersionAdvisory } | null>(null);
  const dismissed = useRef(new Set<string>());
  const [, setDismissal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(null);
    setNotice(null);
    setError(null);
    if (profileId === null) return;
    let live = true;
    let pushed = false;
    const unsubscribe = subscribe("aiProviders:changed", (snapshot) => {
      if (snapshot.profileId !== profileId) return;
      pushed = true;
      setSettings({ profileId, value: snapshot.settings });
    });
    void dispatch("aiProviders:read", { profileId }).then((result) => {
      if (live && !pushed && result.ok) setSettings({ profileId, value: result.value.settings });
    }).catch(() => undefined);
    return () => { live = false; unsubscribe(); };
  }, [profileId]);

  const enabled = settings?.profileId === profileId && settings.value.enabled &&
    jobProviders(settings.value).includes("codex");
  useEffect(() => {
    setNotice(null);
    if (!enabled || profileId === null) return;
    let live = true;
    let sequence = 0;
    const check = (force: boolean) => {
      const request = ++sequence;
      void dispatch("aiProviders:discoverCodex", { profileId, force }).then((result) => {
        if (!live || request !== sequence) return;
        setNotice(result.ok && result.value.versionAdvisory !== undefined
          ? { profileId, advisory: result.value.versionAdvisory } : null);
      }).catch(() => { if (live && request === sequence) setNotice(null); });
    };
    check(false);
    // Returning from a terminal update should settle the notice immediately.
    const focus = () => check(true);
    window.addEventListener("focus", focus);
    return () => { live = false; window.removeEventListener("focus", focus); };
  }, [enabled, profileId, settings]);

  const key = notice === null ? "" : JSON.stringify([notice.profileId, notice.advisory.command, notice.advisory.version]);
  if (!enabled || notice?.profileId !== profileId || dismissed.current.has(key)) return null;
  return (
    <aside className="app-toast codex-version-notice" role="status" aria-live="polite">
      <div className="app-toast__content">
        <p className="app-toast__eyebrow app-toast__eyebrow--info">Update Codex for newer models</p>
        <p className="app-toast__message">{codexVersionMessage(notice.advisory)}</p>
        <CodexVersionHelp key={key} advisory={notice.advisory} compact />
        {error !== null && <p className="settings-field__error" role="alert">{error}</p>}
      </div>
      <div className="app-toast__actions">
        <button type="button" className="app-toast__button" onClick={() => {
          void dispatch("settings:open", { page: "ai-providers", sub: "codex", profileId })
            .then((result) => { if (!result.ok) setError(result.error.message); })
            .catch(() => setError("Couldn’t open AI Providers."));
        }}>AI Providers</button>
        <button type="button" className="app-toast__button" aria-label="Dismiss Codex update notice" onClick={() => {
          dismissed.current.add(key);
          setDismissal((value) => value + 1);
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
