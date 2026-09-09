import type { AgentAccessSnapshot } from "@pwrgit/shared";
import { AgentAccessServer, type AgentAccessServerOptions } from "./agent-access-server";

export type AgentAccessStatus = AgentAccessSnapshot;
export class AgentAccessService {
  private readonly server: AgentAccessServer;
  private enabled = false;
  private error: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: AgentAccessServerOptions & { saveEnabled: (enabled: boolean) => void }) {
    this.server = new AgentAccessServer(options);
  }
  status(): AgentAccessSnapshot {
    return { enabled: this.enabled, listening: this.server.listening, mcpUrl: this.server.mcpUrl,
      ...(this.error ? { error: this.error } : {}) };
  }
  setEnabled(enabled: boolean): Promise<AgentAccessSnapshot> {
    const operation = this.tail.then(async () => {
      this.error = undefined;
      if (enabled) {
        try { await this.server.start(); }
        catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); }
      } else await this.server.stop();
      this.enabled = enabled;
      this.options.saveEnabled(enabled);
      this.options.onChanged();
      return this.status();
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  async dispose() {
    await this.tail;
    await this.server.stop();
  }
}
