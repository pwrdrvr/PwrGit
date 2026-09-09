import { useEffect, useState } from "react";
import { MCP_AGENT_CAPABILITY_DETAILS, type AgentConsentPrompt } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { SettingsSection } from "./SettingsLayout";

export function AgentConsentWindow() {
  const [prompt, setPrompt] = useState<AgentConsentPrompt | null>(null);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void dispatch("agentAccess:consentRead", undefined).then(result => {
      if (!result.ok) { setError(result.error.message); return; }
      setPrompt(result.value); setName(result.value.sessionName);
      setRoleId(result.value.roles.find(r => r.id === "builtin.local-reader")?.id ?? result.value.roles[0]?.id ?? "");
    });
  }, []);
  const role = prompt?.roles.find(r => r.id === roleId);
  const decide = async (decision: "allow" | "deny") => {
    if (!prompt || busy) return;
    setBusy(true);
    const result = await dispatch("agentAccess:consentDecide", {
      requestId: prompt.requestId, decision, sessionName: name, roleId
    });
    if (!result.ok) { setError(result.error.message); setBusy(false); }
  };
  return <main className="agent-consent-window">
    <h1>Approve agent access</h1>
    <p><strong>{prompt?.clientName ?? "Loading agent…"}</strong> wants to read your repositories through PwrGit.</p>
    {error ? <p role="alert" className="settings-field__error">{error}</p> : null}
    {prompt ? <SettingsSection title="Session permissions" eyebrow="Your approval">
      <label className="settings-field"><span>Session Name</span>
        <input autoFocus value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>
      <label className="settings-field"><span>Role</span>
        <select value={roleId} onChange={event => setRoleId(event.target.value)}>
          {prompt.roles.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}
        </select></label>
      {role ? <>
        <ul>{role.permissions.map(p => <li key={p}>{MCP_AGENT_CAPABILITY_DETAILS[p].label}</li>)}</ul>
        <p className="selectable">Repositories: {role.repositoryRoots?.join(", ") ?? "All bounded repositories"}</p>
      </> : <p>No role fits the permissions requested by this agent.</p>}
      <p>You can revoke this Session in Settings → Agents at any time.</p>
      <div className="agent-access-request__actions">
        <button className="settings-button" aria-disabled={busy} onClick={() => void decide("deny")}>Deny</button>
        <button className="settings-button settings-button--primary" disabled={!name.trim() || !role}
          aria-disabled={busy} onClick={() => void decide("allow")}>Approve</button>
      </div>
    </SettingsSection> : null}
  </main>;
}
