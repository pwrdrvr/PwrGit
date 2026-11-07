import { useEffect, useState } from "react";
import type { AgentAccessSnapshot } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

export function connectionRecipes(executable: string, platform: string) {
  const path = "'" + executable.replaceAll("'", platform === "win32" ? "''" : "'\\''") + "'";
  return [
    { name: "Claude Code", command: `claude mcp add --scope user --transport stdio pwrgit -- ${path}` },
    { name: "Codex CLI", command: `codex mcp add pwrgit -- ${path}` }
  ];
}
export function AgentAccessSection() {
  const [snapshot, setSnapshot] = useState<AgentAccessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ token: string; expiresAt: string; inputId: string } | null>(null);
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
  useEffect(() => { if (!snapshot?.listening) setCredential(null); }, [snapshot?.listening]);
  const copy = async (text: string, name: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(name); }
    catch { setError("Could not copy. Select the text and copy it manually."); }
  };
  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true); setError(null); setCredential(null);
    try {
      const result = await dispatch("agentAccess:setEnabled", { enabled });
      if (result.ok) setSnapshot(result.value);
      else setError(result.error.message);
    } catch { setError("Could not change local-agent access."); }
    finally { setBusy(false); }
  };
  const bootstrap = async () => {
    if (busy) return;
    setBusy(true); setError(null); setCredential(null); setCopied(null);
    try {
      const result = await dispatch("agentAccess:bootstrapHttp", undefined);
      if (result.ok) setCredential({ ...result.value, inputId: "pwrgit-mcp-" + crypto.randomUUID() });
      else setError(result.error.message);
    } catch { setError("Approve a new Session in PwrGit, then reconnect manually."); }
    finally { setBusy(false); }
  };
  const config = credential && snapshot ? JSON.stringify({
    inputs: [{ id: credential.inputId, type: "promptString", description: "PwrGit Session credential", password: true }],
    servers: { pwrgit: { type: "http", url: snapshot.mcpUrl, headers: { Authorization: `Bearer \u0024{input:${credential.inputId}}` } } }
  }, null, 2) : null;
  return <>
    <SettingsSection title="MCP server" eyebrow="Local agent access"
      description="The running PwrGit desktop owns every MCP connection. Each new Session requires your approval in PwrGit."
      chip={snapshot?.listening ? "Listening" : snapshot?.error ? "Failed" : "Off"}>
      <div className="agent-access-toggle">
        <div className="agent-access-toggle__copy">
          <b>Enable local-agent access</b>
          <span>Uses a protected local socket or pipe. When off, connections end and saved roles remain available.</span>
        </div>
        <SettingsSwitch checked={snapshot?.enabled === true} disabled={snapshot === null || busy}
          label="Enable local-agent access" onChange={value => void toggle(value)} />
      </div>
      {snapshot?.error || error ? <p className="settings-field__error" role="alert">{error ?? snapshot?.error}</p> : null}
    </SettingsSection>
    <SettingsSection title="Connect an agent" eyebrow="Claude Code and Codex"
      description="Keep PwrGit open. Add the native stdio relay, then choose a Session Name and role in PwrGit’s approval window.">
      {snapshot?.listening ? connectionRecipes(snapshot.executable, snapshot.platform).map(recipe => <div className="agent-connect-recipe" key={recipe.name}>
        <b>{recipe.name}</b><pre className="selectable">{recipe.command}</pre>
        <button className="settings-button" type="button" onClick={() => void copy(recipe.command, recipe.name)}>{copied === recipe.name ? "Copied" : "Copy " + recipe.name + " command"}</button>
      </div>) : <p className="settings-empty">Enable local-agent access to show the connection commands.</p>}
      <p className="settings-empty">Replace old TCP/OAuth or standalone configurations and approve a new Session. If PwrGit closes, reconnect manually in your host. Calls and approvals are never replayed.</p>
    </SettingsSection>
    <SettingsSection title="Direct IPC HTTP" eyebrow="VS Code and compatible hosts"
      description="Connect HTTP directly over the same socket or pipe. Create a Session here first; browser OAuth is not used.">
      <button className="settings-button" type="button" disabled={!snapshot?.listening || busy} onClick={() => void bootstrap()}>Approve a direct HTTP Session</button>
      {credential && config ? <div className="agent-connect-recipe">
        <p>Initialize within two minutes ({new Date(credential.expiresAt).toLocaleTimeString()}). This credential binds one live Session. A disconnect requires fresh approval.</p>
        <label>Session credential<input className="settings-input selectable" type="password" readOnly value={credential.token} autoComplete="off" /></label>
        <button className="settings-button" type="button" onClick={() => void copy(credential.token, "credential")}>{copied === "credential" ? "Copied" : "Copy credential"}</button>
        <pre className="selectable">{config}</pre>
        <button className="settings-button" type="button" onClick={() => void copy(config, "configuration")}>{copied === "configuration" ? "Copied" : "Copy VS Code configuration"}</button>
        <p>Paste the configuration into mcp.json. Enter the credential separately when your host prompts.</p>
      </div> : null}
    </SettingsSection>
  </>;
}
