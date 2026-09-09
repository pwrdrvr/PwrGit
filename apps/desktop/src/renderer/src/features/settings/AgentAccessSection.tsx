import { useCallback, useEffect, useState } from "react";
import type { AgentAccessSnapshot, McpAgentRole } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

/** A pairing request grants read access to the operator's repositories, so the
 * default role offered is the narrowest one that is still useful. */
const DEFAULT_PAIRING_ROLE = "builtin.local-reader";

/** Shared so the credential pane can build a paste-ready config from the same
 * snapshot this section renders, without a second read of the same state. */
export function useAgentAccessSnapshot(): AgentAccessSnapshot | null {
  const [snapshot, setSnapshot] = useState<AgentAccessSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    void dispatch("agentAccess:read", undefined).then((result) => {
      if (!cancelled && result.ok) setSnapshot(result.value);
    });
    const stop = subscribe("agentAccess:changed", (next) => setSnapshot(next));
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  return snapshot;
}

export function AgentAccessSection(props: { roles: McpAgentRole[] }) {
  const [snapshot, setSnapshot] = useState<AgentAccessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleByPairing, setRoleByPairing] = useState<Record<string, string>>({});

  const read = useCallback(async (): Promise<void> => {
    const result = await dispatch("agentAccess:read", undefined);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSnapshot(result.value);
  }, []);

  useEffect(() => {
    void read();
    return subscribe("agentAccess:changed", (next) => setSnapshot(next));
  }, [read]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (enabled: boolean): Promise<void> => {
    const result = await dispatch("agentAccess:setEnabled", { enabled });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSnapshot(result.value);
  };

  const approve = async (pairingId: string): Promise<void> => {
    const roleId = roleByPairing[pairingId] ?? DEFAULT_PAIRING_ROLE;
    const result = await dispatch("agentAccess:approvePairing", { pairingId, roleId });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSnapshot(result.value);
  };

  const deny = async (pairingId: string): Promise<void> => {
    const result = await dispatch("agentAccess:denyPairing", { pairingId });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSnapshot(result.value);
  };

  const enabled = snapshot?.enabled === true;
  const listening = snapshot?.listening === true;
  const pending = snapshot?.pending ?? [];

  return (
    <SettingsSection
      title="Local agent access"
      eyebrow="Pairing"
      description="Let an agent on this machine ask PwrGit for access instead of hand-copying a Session token. Every request still needs your approval here."
      chip={snapshot === null ? undefined : listening ? "Listening" : "Off"}
      chipKind={listening ? "ok" : "default"}
    >
      <div className="agent-access-toggle">
        <div className="agent-access-toggle__copy">
          <b>Accept pairing requests</b>
          <span>
            {listening
              ? `PwrGit is reachable at ${snapshot?.mcpUrl ?? ""} for approved agents only.`
              : "The app accepts no HTTP connections while this is off. Existing stdio Sessions remain active until revoked."}
          </span>
        </div>
        <SettingsSwitch
          checked={enabled}
          disabled={busy || snapshot === null}
          label="Accept pairing requests from local agents"
          onChange={(next) => void run(async () => await setEnabled(next))}
        />
      </div>

      {snapshot?.error !== undefined ? (
        <p className="settings-field__error" role="status">
          {`The listener could not start: ${snapshot.error}`}
        </p>
      ) : null}
      {error !== null ? (
        <p className="settings-field__error" role="status">{error}</p>
      ) : null}

      {enabled ? (
        <div className="agent-access-pending" aria-label="Pending pairing requests">
          {pending.length === 0 ? (
            <p className="settings-empty">
              No requests waiting. Run <code>pwrgit-mcp pair</code> from the agent
              you want to connect.
            </p>
          ) : (
            pending.map((request) => (
              <article className="agent-access-request" key={request.pairingId}>
                <div className="agent-access-request__copy">
                  <b>{request.clientName}</b>
                  <span>
                    {`wants read-only access to your repositories. Expires ${new Date(
                      request.expiresAt
                    ).toLocaleTimeString()}.`}
                  </span>
                </div>
                <label className="agent-access-request__role">
                  <span>Role</span>
                  <select
                    disabled={busy}
                    value={
                      roleByPairing[request.pairingId]
                      ?? DEFAULT_PAIRING_ROLE
                    }
                    onChange={(event) =>
                      setRoleByPairing((current) => ({
                        ...current,
                        [request.pairingId]: event.target.value
                      }))
                    }
                  >
                    {props.roles.map((role) => (
                      <option key={role.id} value={role.id}>{role.name}</option>
                    ))}
                  </select>
                </label>
                <div className="agent-access-request__actions">
                  <button
                    className="settings-button"
                    disabled={busy}
                    type="button"
                    onClick={() => void run(async () => await deny(request.pairingId))}
                  >
                    Deny
                  </button>
                  <button
                    className="settings-button settings-button--primary"
                    disabled={busy}
                    type="button"
                    onClick={() => void run(async () => await approve(request.pairingId))}
                  >
                    Approve
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      ) : null}
    </SettingsSection>
  );
}
