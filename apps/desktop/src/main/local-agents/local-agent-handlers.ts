import {
  McpAccessError,
  McpPolicyStore
} from "@pwrgit/mcp-server/access-policy";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";

function policyResult<T>(operation: () => T): Result<T, PwrGitError> {
  try {
    return ok(operation());
  } catch (cause) {
    return err({
      kind: cause instanceof McpAccessError ? "validation" : "settings",
      code: cause instanceof McpAccessError ? cause.code : "mcp_policy_update_failed",
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

export function registerLocalAgentHandlers(
  bus: CommandBus,
  policy: McpPolicyStore,
  onChanged: () => void
): void {
  bus.register("localAgents:read", () => policyResult(() => policy.initialize()));

  bus.register("localAgents:createSession", (request) => {
    const result = policyResult(() => policy.createSession(request.name, request.roleId));
    if (result.ok) onChanged();
    return result;
  });

  bus.register("localAgents:revoke", (request) => {
    const result = policyResult(() => policy.revokeSession(request.id));
    if (result.ok) onChanged();
    return result;
  });

  bus.register("localAgents:assignRole", (request) => {
    const result = policyResult(() =>
      policy.assignRole(request.sessionId, request.roleId)
    );
    if (result.ok) onChanged();
    return result;
  });

  bus.register("localAgents:roleCreate", (request) => {
    const result = policyResult(() => policy.createRole(request));
    if (result.ok) onChanged();
    return result;
  });

  bus.register("localAgents:roleUpdate", (request) => {
    const result = policyResult(() => policy.updateRole(request.id, request.patch));
    if (result.ok) onChanged();
    return result;
  });

  bus.register("localAgents:roleDelete", (request) => {
    const result = policyResult(() => {
      policy.deleteRole(request.id);
      return null;
    });
    if (result.ok) onChanged();
    return result;
  });
}
