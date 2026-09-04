import { randomUUID } from "node:crypto";
import type { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import {
  PAIRING_TTL_MS,
  type PairingPollResponse,
  type PairingTicket,
  type PendingPairing
} from "@pwrgit/mcp-server/agent-access-protocol";

type PairingState =
  | { kind: "pending"; pairing: PendingPairing }
  | { kind: "denied"; reason: string }
  | {
      kind: "approved";
      token: string;
      policyFile: string;
      session: { id: string; name: string; roleId: string };
    };

/** Holds pairing requests between the moment a client asks and the moment the
 * operator answers in the PwrGit window.
 *
 * A pairing grants read access to the operator's repositories, so nothing here
 * mints a token on its own: `approve` is only reachable from the consent sheet,
 * and a request that is never answered expires rather than lingering. */
export class PairingRegistry {
  private readonly states = new Map<string, PairingState>();

  constructor(
    private readonly policy: McpPolicyStore,
    private readonly onChanged: () => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  request(clientName: string, requestedRoleId?: string): PairingTicket {
    this.prune();
    const trimmed = clientName.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new Error("client name must contain 1 to 200 characters");
    }
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + PAIRING_TTL_MS);
    const pairingId = `pair_${randomUUID()}`;
    this.states.set(pairingId, {
      kind: "pending",
      pairing: {
        pairingId,
        clientName: trimmed,
        ...(requestedRoleId === undefined ? {} : { requestedRoleId }),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      }
    });
    this.onChanged();
    return {
      pairingId,
      expiresAt: expiresAt.toISOString(),
      pollIntervalMs: 1_000
    };
  }

  pending(): PendingPairing[] {
    this.prune();
    return [...this.states.values()]
      .filter((state): state is Extract<PairingState, { kind: "pending" }> =>
        state.kind === "pending"
      )
      .map((state) => state.pairing);
  }

  /** Mints the session. Only the consent sheet reaches this. */
  approve(pairingId: string, roleId: string, sessionName?: string): void {
    this.prune();
    const state = this.states.get(pairingId);
    if (state === undefined || state.kind !== "pending") {
      throw new Error("pairing request is no longer available");
    }
    const credential = this.policy.createSession(
      sessionName?.trim() || state.pairing.clientName,
      roleId
    );
    this.states.set(pairingId, {
      kind: "approved",
      token: credential.token,
      policyFile: credential.environment.policyFile,
      session: {
        id: credential.session.id,
        name: credential.session.name,
        roleId: credential.session.roleId
      }
    });
    this.onChanged();
  }

  deny(pairingId: string, reason = "The operator declined this request."): void {
    const state = this.states.get(pairingId);
    if (state === undefined || state.kind !== "pending") return;
    this.states.set(pairingId, { kind: "denied", reason });
    this.onChanged();
  }

  /** A token is handed out exactly once. A second poll for the same pairing
   * gets `expired`, so a token that leaked into a log cannot be replayed into
   * a second client. */
  poll(pairingId: string, mcpUrl: string): PairingPollResponse {
    this.prune();
    const state = this.states.get(pairingId);
    if (state === undefined) return { status: "expired" };
    if (state.kind === "pending") return { status: "pending" };
    if (state.kind === "denied") {
      this.states.delete(pairingId);
      return { status: "denied", reason: state.reason };
    }
    this.states.delete(pairingId);
    return {
      status: "approved",
      token: state.token,
      policyFile: state.policyFile,
      mcpUrl,
      session: state.session
    };
  }

  clear(): void {
    if (this.states.size === 0) return;
    this.states.clear();
    this.onChanged();
  }

  private prune(): void {
    const now = this.now().getTime();
    let removed = false;
    for (const [pairingId, state] of this.states) {
      if (state.kind !== "pending") continue;
      if (Date.parse(state.pairing.expiresAt) > now) continue;
      this.states.delete(pairingId);
      removed = true;
    }
    if (removed) this.onChanged();
  }
}
