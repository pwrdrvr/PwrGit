import type { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import { AgentAccessServer } from "./agent-access-server.js";
import { PairingRegistry } from "./pairing-registry.js";
import type { PendingPairing } from "@pwrgit/mcp-server/agent-access-protocol";

export type AgentAccessStatus = {
  enabled: boolean;
  listening: boolean;
  mcpUrl: string;
  pending: PendingPairing[];
  /** Set when the listener could not bind — usually another PwrGit instance,
   * or something else already on the port. Surfaced instead of retrying
   * silently, because a client polling a dead endpoint has no other clue. */
  error?: string;
};

export type AgentAccessServiceOptions = {
  policyFile: string;
  appVersion: string;
  onChanged: () => void;
  port?: number;
  log?: (message: string, extra?: unknown) => void;
};

/** Owns the loopback listener's lifecycle and the pairing consent state.
 *
 * The listener is off until the operator turns it on: an always-listening
 * local MCP endpoint is a standing grant on their repositories, and that is
 * their decision to make, not a default. */
export class AgentAccessService {
  private readonly server: AgentAccessServer;
  readonly pairings: PairingRegistry;
  private enabled = false;
  private error: string | undefined;

  constructor(
    policy: McpPolicyStore,
    private readonly options: AgentAccessServiceOptions
  ) {
    this.pairings = new PairingRegistry(policy, options.onChanged);
    this.server = new AgentAccessServer({
      policyFile: options.policyFile,
      appVersion: options.appVersion,
      pairings: this.pairings,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.log === undefined ? {} : { log: options.log })
    });
  }

  status(): AgentAccessStatus {
    return {
      enabled: this.enabled,
      listening: this.server.listening,
      mcpUrl: this.server.mcpUrl,
      pending: this.pairings.pending(),
      ...(this.error === undefined ? {} : { error: this.error })
    };
  }

  async setEnabled(enabled: boolean): Promise<AgentAccessStatus> {
    if (enabled === this.enabled) return this.status();
    this.enabled = enabled;
    this.error = undefined;
    if (enabled) {
      try {
        await this.server.start();
      } catch (cause) {
        this.enabled = false;
        this.error = cause instanceof Error ? cause.message : String(cause);
      }
    } else {
      // Pending requests are consent decisions the operator never made.
      // Turning access off answers them all with "no".
      this.pairings.clear();
      await this.server.stop();
    }
    this.options.onChanged();
    return this.status();
  }

  async dispose(): Promise<void> {
    this.enabled = false;
    await this.server.stop();
  }
}
