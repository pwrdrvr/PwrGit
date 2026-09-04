/** Wire contract for PwrGit's loopback agent-access surface.
 *
 * Three different clients speak this: the PwrGit CLI (`pwrgit-mcp pair`),
 * PwrAgent's MCP connection card, and any third-party agent a user points at
 * it. Keeping the shapes here means none of them has to guess. */

export const AGENT_ACCESS_PROTOCOL = "pwrgit.agent-access/v1" as const;

/** Fixed so a client can find PwrGit without a discovery file. PwrSnap owns
 * 51729; this is PwrGit's slot in the same range. */
export const AGENT_ACCESS_PORT = 51731;

export const AGENT_ACCESS_HEALTH_PATH = "/health";
export const AGENT_ACCESS_PAIR_REQUEST_PATH = "/pair/request";
export const AGENT_ACCESS_PAIR_POLL_PATH = "/pair/poll";
export const AGENT_ACCESS_MCP_PATH = "/mcp";

/** A pairing that is never approved must not sit in memory forever, and a
 * user who walks away from the consent sheet should not leave a live grant
 * behind them. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const PAIRING_POLL_INTERVAL_MS = 1_000;

export type AgentAccessHealth = {
  protocol: typeof AGENT_ACCESS_PROTOCOL;
  app: "PwrGit";
  version: string;
  /** Always true when this endpoint answers: the server only listens while
   * the operator has agent access enabled. Present so a client can assert on
   * a field rather than on the absence of a connection error. */
  agentAccess: true;
  mcpUrl: string;
};

export type PairingRequest = {
  /** Shown verbatim in the consent sheet. */
  clientName: string;
  /** Optional role the client would like; the operator still chooses. */
  requestedRoleId?: string;
};

export type PairingTicket = {
  pairingId: string;
  expiresAt: string;
  pollIntervalMs: number;
};

export type PairingPollResponse =
  | { status: "pending" }
  | { status: "denied"; reason: string }
  | { status: "expired" }
  | {
      status: "approved";
      token: string;
      policyFile: string;
      mcpUrl: string;
      session: { id: string; name: string; roleId: string };
    };

export type PendingPairing = {
  pairingId: string;
  clientName: string;
  requestedRoleId?: string;
  createdAt: string;
  expiresAt: string;
};
