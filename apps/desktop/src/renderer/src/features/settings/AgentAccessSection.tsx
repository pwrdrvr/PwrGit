import { useEffect, useState } from "react";
import type { AgentAccessSnapshot } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

export const CONNECT_RECIPES = [
  { name: "Claude Code", command: "claude mcp add --scope user --transport http pwrgit http://127.0.0.1:51731/mcp\nclaude mcp login pwrgit" },
  { name: "Codex CLI", command: "codex mcp add pwrgit --url http://127.0.0.1:51731/mcp --oauth-client-registration dcr" }
];

export function AgentAccessSection() {
  const [snapshot, setSnapshot] = useState<AgentAccessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    let changed = false;
    const stop = subscribe("agentAccess:changed", next => { changed = true; setSnapshot(next); });
    void dispatch("agentAccess:read", undefined).then(result => {
      if (changed) return;
      if (result.ok) setSnapshot(result.value);
      else setError(result.error.message);
    });
    return () => { changed = true; stop(); };
  }, []);
  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await dispatch("agentAccess:setEnabled", { enabled });
      if (result.ok) setSnapshot(result.value);
      else setError(result.error.message);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <SettingsSection title="MCP server" eyebrow="Local agent access"
      description="Allow agents on this machine to request access. Every connection requires OAuth authorization and your approval in PwrGit."
      chip={snapshot?.listening ? "Listening" : snapshot?.error ? "Failed" : "Off"}>
      <div className="agent-access-toggle">
        <div className="agent-access-toggle__copy">
          <b>Enable local-agent access</b>
          <span>When off, PwrGit does not listen for MCP connections. Saved Sessions and roles remain available.</span>
        </div>
        <SettingsSwitch checked={snapshot?.enabled === true} disabled={snapshot === null || busy}
          label="Enable local-agent access" onChange={value => void toggle(value)} />
      </div>
      {snapshot?.error || error ? <p className="settings-field__error" role="alert">{error ?? snapshot?.error}</p> : null}
    </SettingsSection>
    <SettingsSection title="Connect an agent" eyebrow="Claude Code and Codex"
      description="Run a command below. Your agent opens PwrGit’s approval window; choose a Session Name and role there.">
      {snapshot?.listening ? CONNECT_RECIPES.map(recipe => <div className="agent-connect-recipe" key={recipe.name}>
        <b>{recipe.name}</b>
        <pre className="selectable">{recipe.command}</pre>
        <button className="settings-button" type="button" onClick={() => {
          void navigator.clipboard.writeText(recipe.command).then(() => setCopied(recipe.name)).catch(() => setError("Could not copy the command."));
        }}>{copied === recipe.name ? "Copied" : "Copy " + recipe.name + " command"}</button>
      </div>) : <p className="settings-empty">Enable local-agent access to show the connection commands.</p>}
    </SettingsSection>
  </>;
}
