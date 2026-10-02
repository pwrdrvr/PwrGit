import { useEffect, useRef, useState } from "react";
import { jobProviders, type AiProviderSettings, type CodexVersionAdvisory } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { CodexVersionToastBody } from "./CodexVersionHelp";

/** Probe only when this window's profile enables a feature routed to Codex.
 * Dismissal lasts for this launch; a different runtime can raise a new notice. */
export function CodexVersionNotice({ profileId }: { profileId: string | null }) {
  const [settings, setSettings] = useState<{ profileId: string; value: AiProviderSettings } | null>(null);
  const [notice, setNotice] = useState<{ profileId: string; advisory: CodexVersionAdvisory } | null>(null);
  const dismissed = useRef(new Set<string>());
  const showing = useRef(false);
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
  // Only a change to which Codex runs needs a new probe. Keying on the whole
  // settings object hid the notice and re-probed on every unrelated write.
  const codexSelection = settings === null ? null : JSON.stringify(settings.value.codex);
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
    // With nothing showing there is nothing to settle, so no forced probe.
    const focus = () => { if (showing.current) check(true); };
    window.addEventListener("focus", focus);
    return () => { live = false; window.removeEventListener("focus", focus); };
  }, [enabled, profileId, codexSelection]);

  const key = notice === null ? "" : JSON.stringify([notice.profileId, notice.advisory.command, notice.advisory.version]);
  const visible = enabled && notice?.profileId === profileId && !dismissed.current.has(key);
  useEffect(() => { showing.current = visible; }, [visible]);
  if (!visible || notice === null) return null;
  // One action row, shaped like the "Update ready" card beside it: the
  // primary the installer can act on, then AI Providers, then a text Dismiss.
  return (
    <aside className="app-toast codex-version-notice" role="status" aria-live="polite">
      <CodexVersionToastBody
        key={key}
        advisory={notice.advisory}
        error={error}
        actions={
          <>
            <button type="button" className="app-toast__button" onClick={() => {
              void dispatch("settings:open", { page: "ai-providers", sub: "codex", profileId })
                .then((result) => { if (!result.ok) setError(result.error.message); })
                .catch(() => setError("Couldn’t open AI Providers."));
            }}>AI Providers</button>
            <button type="button" className="app-toast__button" aria-label="Dismiss Codex update notice" onClick={() => {
              dismissed.current.add(key);
              setDismissal((value) => value + 1);
            }}>Dismiss</button>
          </>
        }
      />
    </aside>
  );
}
