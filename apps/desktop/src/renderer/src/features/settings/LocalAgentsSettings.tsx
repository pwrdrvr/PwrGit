import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import {
  MCP_AGENT_CAPABILITIES,
  MCP_AGENT_CAPABILITY_DETAILS,
  type McpAgentCapability,
  type McpAgentPolicySnapshot,
  type McpAgentRole,
  type McpAgentRoleInput
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack
} from "./SettingsLayout";
import { AgentAccessSection } from "./AgentAccessSection";

type RoleDraft = {
  id: string | null;
  name: string;
  description: string;
  permissions: McpAgentCapability[];
  allRepositories: boolean;
  repositoryRoots: string;
};

export function LocalAgentsSettings() {
  const [snapshot, setSnapshot] = useState<McpAgentPolicySnapshot | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (): Promise<void> => {
    const result = await dispatch("localAgents:read", undefined);
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSnapshot(result.value);
    setSelectedSessionId((current) =>
      current !== null && result.value.sessions.some((session) => session.id === current)
        ? current
        : (result.value.sessions.find((session) => session.revokedAt === null)?.id ?? null)
    );
    setSelectedRoleId((current) =>
      current !== null && result.value.roles.some((role) => role.id === current)
        ? current
        : (result.value.roles[0]?.id ?? null)
    );
    setError(null);
  }, []);

  useEffect(() => {
    void read();
    return subscribe("localAgents:changed", (next) => {
      setSnapshot(next);
      setError(null);
    });
  }, [read]);

  const selectedSession = useMemo(
    () => snapshot?.sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, snapshot]
  );
  const selectedRole = useMemo(() => {
    const roleId = selectedSession?.roleId ?? selectedRoleId;
    return snapshot?.roles.find((role) => role.id === roleId) ?? null;
  }, [selectedRoleId, selectedSession, snapshot]);

  const effectivePermissions = selectedRole?.permissions.filter(permission =>
    !selectedSession?.oauth || selectedSession.oauth.scopes.includes(permission)
  ) ?? [];

  const assignRole = async (sessionId: string, roleId: string): Promise<void> => {
    setSaving(true);
    const result = await dispatch("localAgents:assignRole", { sessionId, roleId });
    setSaving(false);
    if (!result.ok) setError(result.error.message);
    else {
      setSelectedRoleId(roleId);
      await read();
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setSaving(true);
    const result = await dispatch("localAgents:revoke", { id });
    setSaving(false);
    if (!result.ok) setError(result.error.message);
    else await read();
  };

  const saveRole = async (): Promise<void> => {
    if (roleDraft === null) return;
    const input = draftInput(roleDraft);
    if (input.permissions.length === 0) {
      setError("Select at least one permission.");
      return;
    }
    setSaving(true);
    const result = roleDraft.id === null
      ? await dispatch("localAgents:roleCreate", input)
      : await dispatch("localAgents:roleUpdate", { id: roleDraft.id, patch: input });
    setSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSelectedRoleId(result.value.id);
    setSelectedSessionId(null);
    setRoleDraft(null);
    await read();
  };

  const deleteRole = async (id: string): Promise<void> => {
    setSaving(true);
    const result = await dispatch("localAgents:roleDelete", { id });
    setSaving(false);
    if (!result.ok) setError(result.error.message);
    else {
      setRoleDraft(null);
      setSelectedRoleId(null);
      await read();
    }
  };

  const activeSessions = snapshot?.sessions.filter((session) => session.revokedAt === null).length ?? 0;

  return (
    <SettingsSectionStack
      aria-label="Local agent settings"
      className="settings-stack--agents"
      paneId="agents"
    >
      <SettingsPanelHead
        eyebrow="Access control"
        title="Local agents"
        help="Authorize agents in PwrGit’s approval window, then manage their Sessions and roles here. Roles define permissions and repository access. Revocation applies to every tool and resource request."
      />

      <AgentAccessSection />

      <SettingsSection
        title="Authorization graph"
        eyebrow="Fail-closed RBAC"
        description="Select a Session to trace its effective role, permissions, and repository boundary."
        chip={snapshot === null ? undefined : `${activeSessions} active`}
        chipKind={activeSessions === 0 ? "warn" : "ok"}
      >
        {loading ? (
          <p className="settings-empty">Loading MCP authorization policy…</p>
        ) : snapshot === null ? (
          <p className="settings-empty">The MCP authorization policy is unavailable.</p>
        ) : (
          <div className="agent-auth-graph" aria-label="Authorization graph">
            <GraphColumn title="Sessions" count={snapshot.sessions.length}>
              {snapshot.sessions.length === 0 ? (
                <p className="agent-auth-empty">No approved Sessions.</p>
              ) : snapshot.sessions.map((session) => {
                const revoked = session.revokedAt !== null;
                return (
                  <article
                    key={session.id}
                    className={`agent-auth-node${selectedSessionId === session.id ? " is-selected" : ""}${revoked ? " is-rejected" : ""}`}
                  >
                    <button
                      className="agent-auth-node__pick"
                      type="button"
                      onClick={() => {
                        setSelectedSessionId(session.id);
                        setSelectedRoleId(session.roleId);
                      }}
                    >
                      <b>{session.name}</b>
                      <span>{revoked ? "Revoked" : "Active"}</span>
                    </button>
                    <select
                      aria-label={`Role for ${session.name}`}
                      className="agent-auth-select"
                      disabled={revoked || saving}
                      value={session.roleId}
                      onChange={(event) => void assignRole(session.id, event.target.value)}
                    >
                      {snapshot.roles.map((role) => (
                        <option key={role.id} value={role.id}>{role.name}</option>
                      ))}
                    </select>
                    <button
                      className="agent-auth-link is-danger"
                      disabled={revoked || saving}
                      type="button"
                      onClick={() => void revoke(session.id)}
                    >
                      Revoke
                    </button>
                  </article>
                );
              })}
            </GraphColumn>

            <GraphColumn title="Roles" count={snapshot.roles.length}>
              {snapshot.roles.map((role) => (
                <button
                  key={role.id}
                  className={`agent-auth-node agent-auth-node--role${selectedRole?.id === role.id ? " is-selected" : ""}`}
                  type="button"
                  onClick={() => {
                    setSelectedSessionId(null);
                    setSelectedRoleId(role.id);
                  }}
                >
                  <span className="agent-auth-node__title"><b>{role.name}</b><i>{role.builtIn ? "built-in" : "custom"}</i></span>
                  <small>{role.permissions.length} permissions · {scopeLabel(role)}</small>
                </button>
              ))}
              <button
                className="settings-button"
                type="button"
                onClick={() => setRoleDraft(newRoleDraft(selectedRole))}
              >
                {selectedRole === null ? "New custom role" : "Duplicate selected role"}
              </button>
            </GraphColumn>

            <GraphColumn title="Permissions & scope" count={MCP_AGENT_CAPABILITIES.length}>
              <div className="agent-auth-scope">
                <span>Repository boundary</span>
                <b>{selectedRole === null ? "Select a role" : scopeLabel(selectedRole)}</b>
                {selectedRole?.repositoryRoots?.map((root) => <code key={root}>{root}</code>)}
              </div>
              {MCP_AGENT_CAPABILITIES.map((capability) => {
                const detail = MCP_AGENT_CAPABILITY_DETAILS[capability];
                const allowed = effectivePermissions.includes(capability);
                return (
                  <div
                    key={capability}
                    className={`agent-auth-permission${allowed ? " is-allowed" : " is-denied"}`}
                  >
                    <span>{allowed ? "✓" : "—"}</span>
                    <div><b>{detail.label}</b><small>{detail.detail}</small></div>
                    <i>{detail.danger}</i>
                  </div>
                );
              })}
              {selectedRole !== null && !selectedRole.builtIn ? (
                <button
                  className="settings-button"
                  type="button"
                  onClick={() => setRoleDraft(newRoleDraft(selectedRole, false))}
                >
                  Edit selected role
                </button>
              ) : null}
            </GraphColumn>
          </div>
        )}
      </SettingsSection>

      {roleDraft !== null ? (
        <RoleEditor
          draft={roleDraft}
          saving={saving}
          onChange={setRoleDraft}
          onCancel={() => setRoleDraft(null)}
          onSave={() => void saveRole()}
          {...(roleDraft.id === null
            ? {}
            : { onDelete: () => void deleteRole(roleDraft.id as string) })}
        />
      ) : null}

      {error !== null ? <p className="settings-field__error" role="alert">{error}</p> : null}
    </SettingsSectionStack>
  );
}

function GraphColumn(props: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="agent-auth-column" aria-label={props.title}>
      <header><span>{props.title}</span><b>{props.count}</b></header>
      <div>{props.children}</div>
    </section>
  );
}

function RoleEditor(props: {
  draft: RoleDraft;
  saving: boolean;
  onChange: (draft: RoleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const { draft } = props;
  return (
    <SettingsSection
      title={draft.id === null ? "Create custom role" : "Edit custom role"}
      eyebrow="Role policy"
      description="Permissions are additive. Repository roots narrow every path-taking tool and both live-notification transports."
    >
      <div className="agent-role-editor">
        <label>Role name<input className="agent-auth-input" value={draft.name} onChange={(event) => props.onChange({ ...draft, name: event.target.value })} /></label>
        <label>Description<input className="agent-auth-input" value={draft.description} onChange={(event) => props.onChange({ ...draft, description: event.target.value })} /></label>
        <fieldset>
          <legend>Permissions</legend>
          {MCP_AGENT_CAPABILITIES.map((capability) => (
            <label key={capability} className={`agent-role-check is-${MCP_AGENT_CAPABILITY_DETAILS[capability].danger}`}>
              <input
                type="checkbox"
                checked={draft.permissions.includes(capability)}
                onChange={(event) => props.onChange({
                  ...draft,
                  permissions: event.target.checked
                    ? [...draft.permissions, capability]
                    : draft.permissions.filter((item) => item !== capability)
                })}
              />
              <span><b>{MCP_AGENT_CAPABILITY_DETAILS[capability].label}</b><small>{MCP_AGENT_CAPABILITY_DETAILS[capability].detail}</small></span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Repository scope</legend>
          <label className="agent-role-radio"><input type="radio" checked={draft.allRepositories} onChange={() => props.onChange({ ...draft, allRepositories: true })} />All repositories reachable through bounded discovery</label>
          <label className="agent-role-radio"><input type="radio" checked={!draft.allRepositories} onChange={() => props.onChange({ ...draft, allRepositories: false })} />Only these existing roots</label>
          {!draft.allRepositories ? (
            <textarea
              className="agent-auth-input agent-auth-textarea selectable"
              aria-label="Repository roots"
              placeholder="One absolute directory per line"
              value={draft.repositoryRoots}
              onChange={(event) => props.onChange({ ...draft, repositoryRoots: event.target.value })}
            />
          ) : null}
        </fieldset>
        <div className="agent-role-actions">
          {props.onDelete === undefined ? <span /> : <button className="settings-button agent-auth-danger-button" disabled={props.saving} type="button" onClick={props.onDelete}>Delete role</button>}
          <div>
            <button className="settings-button" type="button" onClick={props.onCancel}>Cancel</button>
            <button className="settings-button settings-button--primary" disabled={props.saving} type="button" onClick={props.onSave}>Save role</button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

function scopeLabel(role: McpAgentRole): string {
  if (role.repositoryRoots === null) return "All bounded repositories";
  return `${role.repositoryRoots.length} approved root${role.repositoryRoots.length === 1 ? "" : "s"}`;
}

function newRoleDraft(role: McpAgentRole | null, duplicate = true): RoleDraft {
  return {
    id: duplicate ? null : role?.id ?? null,
    name: role === null ? "" : duplicate ? `${role.name} copy` : role.name,
    description: role?.description ?? "",
    permissions: [...(role?.permissions ?? ["repository.roots.read"])],
    allRepositories: role?.repositoryRoots === null || role === null,
    repositoryRoots: role?.repositoryRoots?.join("\n") ?? ""
  };
}

function draftInput(draft: RoleDraft): McpAgentRoleInput {
  return {
    name: draft.name,
    description: draft.description,
    permissions: [...draft.permissions],
    repositoryRoots: draft.allRepositories
      ? null
      : [...new Set(draft.repositoryRoots.split(/\r?\n/u).map((root) => root.trim()).filter(Boolean))]
  };
}

/** Prefers a complete, paste-ready client config over two environment
 * variables: the variables still left the operator to work out the command,
 * the script path, and the JSON shape by hand, which is most of the setup
 * cost this pane exists to remove. Falls back to the variables when the app
 * ships no single-file server to point at. */
