import type { McpAgentCapability } from "@pwrgit/mcp-server/access-policy";

export type ConsentRequest = {
  clientName: string;
  scopes: McpAgentCapability[];
  signal: AbortSignal;
};
export type ConsentDecision = { decision: "allow" | "deny"; sessionName: string; roleId: string };
export type RequestConsent = (request: ConsentRequest) => Promise<ConsentDecision>;
