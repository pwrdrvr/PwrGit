import { useState, type ReactNode } from "react";
import type { CodexVersionAdvisory } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

const CODEX_RELEASES_URL = "https://github.com/openai/codex/releases";

/** The launch notice's one-sentence reason. Model names match the pickers. */
export function codexVersionMessage(advisory: CodexVersionAdvisory): string {
  return `Codex ${advisory.version} is older than ${advisory.minimumVersion}, which GPT-6 Sol and GPT-6.1 Sol need.`;
}

/** The AI Providers Version field's sub-line: what the gap costs. */
export function codexVersionNeed(advisory: CodexVersionAdvisory): string {
  return `GPT-6 Sol and GPT-6.1 Sol need ${advisory.minimumVersion} or newer. Older builds may not list or run them.`;
}

/** The AI Features line above the pickers: why Sol may be missing there. */
export function codexModelsNotice(advisory: CodexVersionAdvisory): string {
  return `Codex ${advisory.version} may not offer GPT-6 Sol or GPT-6.1 Sol. ${advisory.minimumVersion} or newer is recommended.`;
}

/** What to do, phrased for the surface. The notice re-checks on window focus;
 *  only the AI Providers page has a Re-check button to name. */
function codexVersionHint(advisory: CodexVersionAdvisory, surface: "notice" | "settings"): string {
  const then = surface === "notice"
    ? "PwrGit checks again when you switch back."
    : "Then Re-check at the top of this page.";
  if (advisory.upgradeCommand !== undefined) {
    return surface === "notice"
      ? `Run it in a terminal. ${then}`
      : "Run it in a terminal, then Re-check at the top of this page.";
  }
  if (advisory.installer === "application") {
    return `Update the app that supplies this Codex binary (on macOS, often Codex.app) with its own updater. ${then}`;
  }
  return `Update Codex with the installer you originally used. For a standalone binary, download the matching macOS, Windows, or Linux build from Codex releases and replace the selected executable. ${then}`;
}

/** Copy and open-releases state shared by both surfaces. Commands are copied,
 *  never executed by PwrGit. Only main classifies the selected executable. */
function useCodexVersionActions(advisory: CodexVersionAdvisory) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = (): void => {
    const command = advisory.upgradeCommand;
    if (command === undefined) return;
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setError(null);
    }).catch(() => {
      setCopied(false);
      setError("Couldn’t copy the command. Select and copy it above.");
    });
  };
  const openReleases = (): void => {
    void dispatch("shell:openExternal", { url: CODEX_RELEASES_URL })
      .then((result) => { if (!result.ok) setError(result.error.message); })
      .catch(() => setError("Couldn’t open the Codex releases page."));
  };
  return { copied, error, copy, openReleases };
}

/** The AI Providers Codex card's Version field. The card's badge already says
 *  "Update recommended", so this states the gap and how to close it. */
export function CodexVersionHelp({ advisory }: { advisory: CodexVersionAdvisory }) {
  const { copied, error, copy, openReleases } = useCodexVersionActions(advisory);
  return (
    <div className="codex-version-help">
      <p className="codex-version-help__gap">
        {advisory.version} <span aria-hidden="true">→</span>{" "}
        <span className="codex-version-help__want">{advisory.minimumVersion} recommended</span>
      </p>
      {advisory.upgradeCommand !== undefined && (
        <div className="codex-version-well">
          <code>{advisory.upgradeCommand}</code>
          <button type="button" className="settings-inline-button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <p className="settings-field__help">{codexVersionHint(advisory, "settings")}</p>
      <div className="settings-field__actions">
        <button type="button" className="settings-inline-button" onClick={openReleases}>
          Codex releases ↗
        </button>
      </div>
      {error !== null && <p className="settings-field__error" role="alert">{error}</p>}
    </div>
  );
}

/** The launch notice's body and its single action row: the primary is what
 *  this installer can act on (copy the command, else open releases), then the
 *  caller's own actions (AI Providers, Dismiss). */
export function CodexVersionToastBody({ advisory, actions, error: outerError }: {
  advisory: CodexVersionAdvisory;
  actions: ReactNode;
  error: string | null;
}) {
  const { copied, error, copy, openReleases } = useCodexVersionActions(advisory);
  const shown = error ?? outerError;
  return (
    <>
      <div className="app-toast__content">
        <p className="app-toast__eyebrow app-toast__eyebrow--info">Codex update recommended</p>
        <p className="app-toast__message">{codexVersionMessage(advisory)}</p>
        {advisory.upgradeCommand !== undefined && (
          <div className="codex-version-well">
            <code>{advisory.upgradeCommand}</code>
          </div>
        )}
        <p className="app-toast__hint">{codexVersionHint(advisory, "notice")}</p>
        {shown !== null && <p className="app-toast__error" role="alert">{shown}</p>}
      </div>
      <div className="app-toast__actions">
        {advisory.upgradeCommand !== undefined ? (
          <button type="button" className="app-toast__button app-toast__button--primary" onClick={copy}>
            {copied ? "Copied" : "Copy command"}
          </button>
        ) : (
          <button type="button" className="app-toast__button app-toast__button--primary" onClick={openReleases}>
            Codex releases ↗
          </button>
        )}
        {actions}
      </div>
    </>
  );
}
