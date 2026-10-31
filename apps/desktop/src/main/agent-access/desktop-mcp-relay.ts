import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import type { PwrGitMcpServer } from "@pwrgit/mcp-server";
import { MCP_RELAY_PATH, MCP_RELAY_PROTOCOL, MCP_DESKTOP_VERSION_HEADER } from "@pwrgit/mcp-server/agent-access-protocol";

class AuthorizedTransport extends StdioServerTransport {
  constructor(stream: Duplex, private readonly validate: () => boolean, private readonly disconnect: () => void) {
    super(stream, stream, { maxBufferSize: 64 * 1024 });
  }
  override async start() {
    const deliver = this.onmessage;
    this.onmessage = message => { if (this.validate()) deliver?.(message); };
    await super.start();
  }
  override async close() {
    try { await super.close(); }
    finally { this.disconnect(); }
  }
}

type Connection = { sessionId: string; lifetime: Promise<void> };

/** Shares the opt-in HTTP listener, but never relaxes HTTP's OAuth requirement.
 * Saved legacy stdio tokens are accepted only on this authenticated upgrade. */
export class DesktopMcpRelay {
  private readonly websocket = new WebSocketServer({
    noServer: true, maxPayload: 64 * 1024,
    handleProtocols: protocols => protocols.has(MCP_RELAY_PROTOCOL) ? MCP_RELAY_PROTOCOL : false
  });
  private readonly connections = new Map<WebSocket, Connection>();
  private admission: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly options: {
    http: HttpServer;
    policyFile: string;
    desktopVersion: string;
    authority: () => string;
    allowedOrigin: (origin: string | undefined) => boolean;
    createServer: (token: string) => Promise<PwrGitMcpServer>;
  }) {
    this.websocket.on("headers", headers => {
      headers.push(`${MCP_DESKTOP_VERSION_HEADER}: ${options.desktopVersion}`);
    });
    options.http.on("upgrade", this.upgrade);
  }

  private readonly upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const operation = this.admission.then(() => this.admit(req, socket, head));
    this.admission = operation.catch(() => { socket.destroy(); });
  };

  private async admit(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.closing || socket.destroyed) { socket.destroy(); return; }
    const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.url !== MCP_RELAY_PATH || req.headers.host !== this.options.authority() ||
        !this.options.allowedOrigin(req.headers.origin)) { reject("403 Forbidden"); return; }
    const protocols = req.headers["sec-websocket-protocol"]?.split(",").map(p => p.trim());
    if (!protocols?.includes(MCP_RELAY_PROTOCOL)) { reject("426 Upgrade Required"); return; }
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization?.trim() ?? "")?.[1];
    const policy = new McpPolicyStore(this.options.policyFile);
    let sessionId: string;
    try {
      if (!token) throw new Error("Missing Session");
      sessionId = policy.authorize(token).sessionId;
    } catch { reject("401 Unauthorized"); return; }
    await this.reclaimRevokedConnections(policy);
    if (this.closing || socket.destroyed) { socket.destroy(); return; }
    // Reclamation may have waited for server cleanup. Consent can be revoked
    // during that wait, so admission must validate the credential again.
    try { policy.authorize(token!); }
    catch { reject("401 Unauthorized"); return; }
    if (this.connections.size >= 16) { reject("429 Too Many Requests"); return; }
    this.websocket.handleUpgrade(req, socket, head, websocket => {
      // Attach the byte stream immediately so early initialization is buffered
      // while the desktop constructs its own authoritative MCP implementation.
      const stream = createWebSocketStream(websocket);
      stream.on("error", () => websocket.terminate());
      const transport = new AuthorizedTransport(stream, () => {
        // Includes discovery and protocol requests. Handlers also revalidate
        // capabilities, OAuth scopes and canonical repository paths.
        try { policy.authorize(token!); return true; }
        catch { websocket.close(1008, "Session invalid or revoked"); return false; }
      }, () => websocket.terminate());
      let closeConnection!: () => void;
      const disconnected = new Promise<void>(resolve => { closeConnection = resolve; });
      websocket.once("close", closeConnection);
      const lifetime = (async () => {
        let server: PwrGitMcpServer | undefined;
        try {
          server = await this.options.createServer(token!);
          if (websocket.readyState !== websocket.OPEN) return;
          await server.mcp.connect(transport);
          await disconnected;
        } catch {
          websocket.close(1011, "Desktop MCP connection failed");
        } finally {
          try { await server?.close(); }
          finally { stream.destroy(); }
        }
      })();
      this.connections.set(websocket, { sessionId, lifetime });
      const forget = () => { this.connections.delete(websocket); };
      void lifetime.then(forget, forget);
    });
  }

  private async reclaimRevokedConnections(policy: McpPolicyStore): Promise<void> {
    const active = new Set(policy.snapshot().sessions
      .filter(session => session.revokedAt === null).map(session => session.id));
    const retired: Promise<void>[] = [];
    for (const [websocket, connection] of this.connections) {
      if (active.has(connection.sessionId)) continue;
      websocket.terminate();
      retired.push(connection.lifetime);
    }
    // Keep slots occupied until their MCP servers, watches and event listeners
    // finish closing. Admissions are serialized so concurrent upgrades share
    // this cleanup and cannot race past the cap.
    await Promise.allSettled(retired);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.options.http.off("upgrade", this.upgrade);
    for (const websocket of this.connections.keys()) websocket.terminate();
    await this.admission;
    await Promise.allSettled([...this.connections.values()].map(connection => connection.lifetime));
    await new Promise<void>(resolve => this.websocket.close(() => resolve()));
  }
}
