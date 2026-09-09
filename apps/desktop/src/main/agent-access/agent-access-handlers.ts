import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { AgentAccessService } from "./agent-access-service";

export function registerAgentAccessHandlers(bus: CommandBus, service: AgentAccessService): void {
  bus.register("agentAccess:read", () => ok(service.status()));
  bus.register("agentAccess:setEnabled", async (request) => {
    if (typeof request?.enabled !== "boolean") return err({
      kind: "validation", code: "invalid_agent_access", message: "enabled must be a boolean"
    });
    return ok(await service.setEnabled(request.enabled));
  });
}
