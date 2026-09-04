import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { AgentAccessService, AgentAccessStatus } from "./agent-access-service";

function failure(cause: unknown): PwrGitError {
  return {
    kind: "validation",
    code: "agent_access_failed",
    message: cause instanceof Error ? cause.message : String(cause)
  };
}

export function registerAgentAccessHandlers(
  bus: CommandBus,
  service: AgentAccessService
): void {
  bus.register("agentAccess:read", (): Result<AgentAccessStatus, PwrGitError> =>
    ok(service.status())
  );

  bus.register("agentAccess:setEnabled", async (request) => {
    try {
      return ok(await service.setEnabled(request.enabled));
    } catch (cause) {
      return err(failure(cause));
    }
  });

  bus.register("agentAccess:approvePairing", (request) => {
    try {
      service.pairings.approve(
        request.pairingId,
        request.roleId,
        request.sessionName
      );
      return ok(service.status());
    } catch (cause) {
      return err(failure(cause));
    }
  });

  bus.register("agentAccess:denyPairing", (request) => {
    service.pairings.deny(request.pairingId);
    return ok(service.status());
  });
}
