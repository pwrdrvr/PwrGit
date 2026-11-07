import { InitializeRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpPolicyStore, PolicyFileAuthorizer, MCP_AGENT_CAPABILITIES } from "@pwrgit/mcp-server/access-policy";
import { createPwrGitMcpServer, type PwrGitMcpServer, type CommandRunner, type AppBackend } from "@pwrgit/mcp-server";
import { NativeMcpBridge, type McpConnection, type McpByteTransport } from "./native-mcp-bridge";
import { IpcHttpMcp, IpcHttpTransport } from "./ipc-http-mcp";
import { McpSessionPool } from "./mcp-session-pool";
import { mcpExecutablePath } from "./mcp-executable";
import type { RequestConsent } from "./agent-consent";

export type AgentAccessServerOptions = {
  desktopVersion: string;
  appBackend?: AppBackend;
  runner: CommandRunner;
  policyFile: string;
  requestConsent: RequestConsent;
  onChanged: () => void;
  endpoint?: string;
  executable?: string;
};
type Session = {
  id: number;
  transport: McpByteTransport | IpcHttpTransport;
  token?: string;
  server?: PwrGitMcpServer;
  construction?: Promise<void>;
  cleanup?: Promise<void>;
  initialized: boolean;
};

/** The desktop constructs handlers and authorizes work. Its native child owns
 * OS IPC, never MCP tools or privileged filesystem operations. */
export class AgentAccessServer {
  private bridge: NativeMcpBridge | undefined;
  private http: IpcHttpMcp | undefined;
  private stopped = true;
  private nextHttpId = 0;
  private readonly pending = new Set<Session>();
  private readonly pool = new McpSessionPool<Session>(16,
    async session => {
      if (this.stopped || session.transport.controller.signal.aborted) return false;
      if (!session.token) return true; // Reserved during native consent.
      try { this.policy.authorize(session.token); return true; } catch { return false; }
    }, session => this.closeSession(session));
  private readonly policy: McpPolicyStore;
  constructor(private readonly options: AgentAccessServerOptions) {
    this.policy = new McpPolicyStore(options.policyFile);
  }
  get mcpUrl() { return this.bridge?.httpUrl() ?? ""; }
  get executable() { return this.options.executable ?? mcpExecutablePath(); }
  get listening() { return !this.stopped && this.bridge?.isRunning() === true; }

  async start(): Promise<void> {
    if (this.listening) return;
    this.stopped = false;
    this.http = new IpcHttpMcp(async (transport, initialize) => {
      const session = this.session(--this.nextHttpId, transport);
      if (!(await this.pool.admit(session.id, session))) {
        await this.closeSession(session);
        throw new Error("MCP Session limit reached; revoke an unused Session and reconnect");
      }
      await this.prepare(session, initialize);
    });
    const bridge = new NativeMcpBridge({
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      executable: this.executable, allowHttp: true,
      onConnection: input => this.accept(input)
    });
    this.bridge = bridge;
    bridge.onclose = () => {
      this.stopped = true;
      void this.http?.close();
      void this.pool.clear();
      this.options.onChanged();
    };
    try { await bridge.start(); }
    catch (cause) { await this.stop(); throw cause; }
  }

  async bootstrapHttp(signal: AbortSignal) {
    if (!this.listening || !this.http) throw new Error("Open PwrGit and enable local-agent access, then reconnect manually");
    return this.http.bootstrap(signal);
  }

  private accept(input: McpConnection): void {
    if (this.stopped) return;
    if (input.framing === "http") { this.http!.accept(input.createStream()); return; }
    let session: Session;
    let admission: Promise<boolean>;
    const transport = input.createTransport(async initialize => {
      clearTimeout(timer);
      if (!(await admission) || input.identity !== null) throw new Error("Legacy credentials are not accepted; approve a new native Session");
      await this.prepare(session, initialize);
    });
    session = this.session(input.id, transport);
    const timer = setTimeout(() => void transport.close(), 30_000);
    timer.unref();
    transport.controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    admission = this.pool.admit(input.id, session);
    void admission.then(allowed => { if (!allowed) void transport.close(); }, () => void transport.close());
    void transport.start().catch(() => void transport.close());
  }

  private session(id: number, transport: Session["transport"]): Session {
    const session: Session = { id, transport, initialized: false };
    this.pending.add(session);
    transport.controller.signal.addEventListener("abort", () => { void this.closeSession(session); }, { once: true });
    return session;
  }

  private async prepare(session: Session, message: JSONRPCMessage): Promise<void> {
    const initialize = InitializeRequestSchema.parse(message);
    const signal = session.transport.controller.signal;
    const timer = setTimeout(() => void session.transport.close(), 5 * 60_000);
    timer.unref();
    try {
      const decision = await this.options.requestConsent({
        clientName: initialize.params.clientInfo.name.slice(0, 200),
        scopes: [...MCP_AGENT_CAPABILITIES], signal
      });
      if (signal.aborted || this.stopped || decision.decision !== "allow") throw new Error("Native consent denied or disconnected; reconnect manually");
      // ConsentBroker checks the displayed role is unchanged. Persist its
      // ceiling so later role assignment/editing cannot widen this approval.
      const issued = this.policy.createNativeSession(decision.sessionName, decision.roleId);
      session.token = issued.token;
      if (session.transport instanceof IpcHttpTransport)
        session.transport.validate = () => { this.policy.authorize(issued.token); };
      this.options.onChanged();
      session.construction = (async () => {
        const server = await createPwrGitMcpServer({
          serverVersion: this.options.desktopVersion,
          authorizer: new PolicyFileAuthorizer(this.options.policyFile, issued.token),
          runner: this.options.runner,
          ...(this.options.appBackend ? { appBackend: this.options.appBackend } : {})
        });
        session.server = server;
        if (signal.aborted || this.stopped) return;
        await server.mcp.connect(session.transport);
        const deliver = session.transport.onmessage;
        session.transport.onmessage = (next, ...extra) => {
          try {
            this.policy.authorize(issued.token);
            if ("method" in next && next.method === "initialize") {
              if (session.initialized) throw new Error("Session already initialized");
              session.initialized = true;
            }
            deliver?.(next, ...extra);
          } catch { void session.transport.close(); }
        };
      })();
      await session.construction;
      if (signal.aborted || this.stopped) throw new Error("Disconnected during consent; approve a new Session");
    } finally { clearTimeout(timer); }
  }

  private closeSession(session: Session): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.cleanup = Promise.resolve().then(async () => {
      await session.transport.close();
      await session.construction?.catch(() => undefined);
      await session.server?.close();
      if (session.token) {
        try { this.policy.revokeSession(this.policy.authorize(session.token).sessionId); } catch { /* already revoked */ }
      }
      this.pending.delete(session);
      this.pool.remove(session.id);
      this.options.onChanged();
    });
    return session.cleanup;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.http?.close();
    this.http = undefined;
    await this.bridge?.stop();
    this.bridge = undefined;
    await this.pool.clear();
    await Promise.all([...this.pending].map(session => this.closeSession(session)));
  }
}
