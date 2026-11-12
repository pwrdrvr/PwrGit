import fc from "fast-check";
import { expect, it } from "vitest";
import { BUILT_IN_MCP_ROLES, type McpAgentRole, type McpAgentSession } from "@pwrgit/mcp-server/access-policy";
import { DEFAULT_RELAY_ROLE_ID, relaySessionGrant } from "./relay-session-grant";

const builtIns: McpAgentRole[] = BUILT_IN_MCP_ROLES.map(role => ({ ...role, permissions: [...role.permissions] }));
const roleId = fc.oneof(
  fc.constantFrom(...builtIns.map(role => role.id)),
  fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/)
);
const custom = fc.uniqueArray(fc.stringMatching(/^role_[a-z0-9]{1,6}$/), { maxLength: 4 })
  .map(ids => ids.map(id => ({ id, name: id, description: "", builtIn: false, permissions: [], repositoryRoots: null }) as McpAgentRole));
const sessions = fc.array(fc.record({
  name: fc.constantFrom("Host", "Host 2", "Host 3", "Other"),
  revoked: fc.boolean()
}), { maxLength: 6 }).map(list => list.map((s, i) => ({
  id: `session_${i}`, name: s.name, roleId: DEFAULT_RELAY_ROLE_ID, createdAt: "", updatedAt: "",
  revokedAt: s.revoked ? "2026-01-01T00:00:00.000Z" : null
}) as McpAgentSession));

it("a relay gets exactly the role it asked for, the default when it asked for none, and nothing for an unknown role", () => {
  fc.assert(fc.property(custom, sessions, fc.option(roleId, { nil: null }), (customRoles, existing, requested) => {
    const roles = [...builtIns, ...customRoles];
    const snapshot = { roles, sessions: existing };
    const wanted = requested ?? DEFAULT_RELAY_ROLE_ID;
    if (!roles.some(role => role.id === wanted)) {
      // Fail closed, and say which ids would work.
      expect(() => relaySessionGrant(snapshot, "Host", requested)).toThrow(roles.map(role => role.id).join(", "));
      return;
    }
    const grant = relaySessionGrant(snapshot, "Host", requested);
    expect(grant.roleId).toBe(wanted);
    const active = existing.filter(s => s.revokedAt === null).map(s => s.name);
    expect(active).not.toContain(grant.sessionName);
    expect(grant.sessionName.startsWith("Host")).toBe(true);
  }));
});

it("the default relay role is the most capable built-in role", () => {
  const widest = Math.max(...builtIns.map(role => role.permissions.length));
  const fallback = builtIns.find(role => role.id === DEFAULT_RELAY_ROLE_ID);
  expect(fallback?.permissions.length).toBe(widest);
  for (const role of builtIns)
    expect(role.permissions.every(p => fallback!.permissions.includes(p))).toBe(true);
});
