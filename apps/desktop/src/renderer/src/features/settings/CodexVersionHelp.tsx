import { useState } from "react";
import type { CodexVersionAdvisory } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

export function codexVersionMessage(advisory: CodexVersionAdvisory): string {
  return `Codex ${advisory.version} is below the recommended ${advisory.minimumVersion}. Older builds may not offer or run GPT-6-Sol and GPT-6.1-Sol. Update the selected install to use these models.`;
}

/** Shared by the provider card and the launch notice. Commands are copied,
 * never executed by PwrGit. Only main classifies the selected executable. */
export function CodexVersionHelp({ advisory, compact = false }: {
  advisory: CodexVersionAdvisory;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonClass = compact ? "app-toast__button" : "settings-button";
  const help = advisory.upgradeCommand !== undefined
    ? "Run this command in a terminal, then Re-check."
    : advisory.installer === "application"
      ? "Update the app that supplies this Codex binary using its updater. On macOS, Codex may come from Codex.app; on Windows, update the supplying app. Then Re-check."
      : "Update Codex with the installer you originally used. For a standalone binary on macOS, Windows, or Linux, download the matching platform and architecture from the Codex releases page, replace the selected executable, then Re-check.";
  return (
    <div className="codex-version-help">
      <p className={compact ? "app-toast__detail" : "settings-field__help"}>{help}</p>
      {advisory.upgradeCommand !== undefined && (
        <p className={compact ? "app-toast__detail" : "settings-field__help"}>
          <code>{advisory.upgradeCommand}</code>
        </p>
      )}
      <div className={compact ? "app-toast__actions" : "settings-field__actions"}>
        {advisory.upgradeCommand !== undefined && (
          <button type="button" className={buttonClass} onClick={() => {
            void navigator.clipboard.writeText(advisory.upgradeCommand!).then(() => {
              setCopied(true);
              setError(null);
            }).catch(() => setError("Couldn’t copy the command. Select and copy it above."));
          }}>{copied ? "Copied" : "Copy command"}</button>
        )}
        <button type="button" className={buttonClass} onClick={() => {
          void dispatch("shell:openExternal", { url: "https://github.com/openai/codex/releases" })
            .then((result) => { if (!result.ok) setError(result.error.message); })
            .catch(() => setError("Couldn’t open the Codex releases page."));
        }}>Codex releases</button>
      </div>
      {error !== null && <p className="settings-field__error" role="alert">{error}</p>}
    </div>
  );
}
