import { randomUUID } from "node:crypto";
import { err, ok, type AgentConsentDecision, type AgentConsentPrompt } from "@pwrgit/shared";
import type { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import type { CommandBus, CommandContext } from "../command-bus";
import type { RequestConsent, ConsentDecision } from "./agent-oauth";

export type ConsentWindow = {
  webContents: { id: number };
  once: (event: "closed", listener: () => void) => unknown;
  close: () => void;
};
type Pending = { prompt: AgentConsentPrompt; window: ConsentWindow; finish: (decision: ConsentDecision) => void };

/** Only the main frame of the window created for this request can approve it.
 * Request IDs and the browser's status page confer no approval authority. */
export class ConsentBroker {
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly policy: McpPolicyStore, private readonly createWindow: () => ConsentWindow) {}

  request: RequestConsent = async ({ clientName, scopes, signal }) => {
    const denied: ConsentDecision = { decision: "deny", sessionName: "", roleId: "" };
    if (signal.aborted || this.pending.size >= 8) return denied;
    const snapshot = this.policy.snapshot();
    const roles = snapshot.roles.filter(r => r.permissions.every(p => scopes.includes(p)));
    const names = new Set(snapshot.sessions.filter(s => s.revokedAt === null).map(s => s.name));
    const base = clientName.slice(0, 180);
    let sessionName = base;
    for (let suffix = 2; names.has(sessionName); suffix++) sessionName = base + " " + suffix;
    const prompt: AgentConsentPrompt = { requestId: randomUUID(), clientName, sessionName, roles };
    const window = this.createWindow();
    return new Promise(resolve => {
      const id = window.webContents.id;
      const abort = () => finish(denied);
      const finish = (decision: ConsentDecision) => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener("abort", abort);
        resolve(decision);
        window.close();
      };
      this.pending.set(id, { prompt, window, finish });
      signal.addEventListener("abort", abort, { once: true });
      window.once("closed", abort);
      if (signal.aborted) abort();
    });
  };

  private trusted(context: CommandContext): Pending | undefined {
    return context.isMainFrame === true && context.webContentsId !== undefined
      ? this.pending.get(context.webContentsId) : undefined;
  }
  register(bus: CommandBus) {
    const forbidden = () => err({ kind: "validation" as const, code: "untrusted_consent", message: "Approval is only available in the requesting PwrGit window." });
    bus.register("agentAccess:consentRead", (_request, context) => {
      const pending = this.trusted(context);
      return pending ? ok(pending.prompt) : forbidden();
    });
    bus.register("agentAccess:consentDecide", (request: AgentConsentDecision, context) => {
      const pending = this.trusted(context);
      if (!pending || request?.requestId !== pending.prompt.requestId) return forbidden();
      if (request.decision !== "allow" && request.decision !== "deny") return forbidden();
      if (request.decision === "allow" && (
        typeof request.sessionName !== "string" || !request.sessionName.trim() ||
        request.sessionName.trim().length > 200 ||
        !pending.prompt.roles.some(r => r.id === request.roleId)
      )) return err({ kind: "validation", code: "invalid_consent", message: "Enter a Session Name and choose an available role." });
      pending.finish(request);
      return ok(null);
    });
  }
}
