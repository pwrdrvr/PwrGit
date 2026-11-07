import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { AgentAccessService } from "./agent-access-service";

export function registerAgentAccessHandlers(bus: CommandBus, service: AgentAccessService): void {
  bus.register("agentAccess:bootstrapHttp", async (_request, context) => {
    try { return ok(await service.bootstrapHttp(context.signal ?? new AbortController().signal)); }
    catch { return err({ kind: "validation", code: "ipc_consent_failed", message: "Enable local-agent access and approve a new native Session, then reconnect manually." }); }
  });
  bus.register("agentAccess:read", () => ok(service.status()));
  bus.register("agentAccess:setEnabled", async (request) => {
    if (typeof request?.enabled !== "boolean") return err({
      kind: "validation", code: "invalid_agent_access", message: "enabled must be a boolean"
    });
    return ok(await service.setEnabled(request.enabled));
  });
}
