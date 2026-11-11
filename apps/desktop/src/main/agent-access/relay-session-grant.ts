import type { McpPolicySnapshot } from "@pwrgit/mcp-server/access-policy";

/**
 * The role a relay gets when its command line names none: the most capable
 * built-in role. An operator who does not trust a model with that connects it
 * with `pwrgit-mcp --role <id>`; a model trusted with nothing local belongs in
 * a contained outpost, not on this machine's relay.
 */
export const DEFAULT_RELAY_ROLE_ID = "builtin.app-operator";

/** A name no active Session uses: `base`, then `base 2`, `base 3`, ... */
export function uniqueSessionName(clientName: string, snapshot: Pick<McpPolicySnapshot, "sessions">): string {
  const names = new Set(snapshot.sessions.filter(s => s.revokedAt === null).map(s => s.name));
  const base = clientName.trim().slice(0, 180) || "Local MCP client";
  let sessionName = base;
  for (let suffix = 2; names.has(sessionName); suffix++) sessionName = base + " " + suffix;
  return sessionName;
}

/**
 * What a relay connection is granted, with no prompt: exactly the role its
 * command line asked for, or the default role when it asked for none. A role
 * this policy does not define fails closed. It never falls back to another
 * role, least of all a more capable one.
 */
export function relaySessionGrant(
  snapshot: Pick<McpPolicySnapshot, "roles" | "sessions">,
  clientName: string,
  requestedRole: string | null
): { sessionName: string; roleId: string } {
  const roleId = requestedRole ?? DEFAULT_RELAY_ROLE_ID;
  if (!snapshot.roles.some(role => role.id === roleId)) {
    const valid = snapshot.roles.map(role => role.id).join(", ");
    throw new Error(
      `PwrGit has no role "${roleId}". Reconnect with pwrgit-mcp --role set to one of: ${valid}.`
    );
  }
  return { sessionName: uniqueSessionName(clientName, snapshot), roleId };
}
