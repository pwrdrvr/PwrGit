import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PolicyFileAuthorizer } from "@pwrgit/mcp-server/access-policy";
import { createPwrGitMcpServer, type PwrGitMcpServer } from "@pwrgit/mcp-server";
import {
  AGENT_ACCESS_HEALTH_PATH,
  AGENT_ACCESS_MCP_PATH,
  AGENT_ACCESS_PAIR_POLL_PATH,
  AGENT_ACCESS_PAIR_REQUEST_PATH,
  AGENT_ACCESS_PORT,
  AGENT_ACCESS_PROTOCOL,
  type AgentAccessHealth
} from "@pwrgit/mcp-server/agent-access-protocol";
import type { PairingRegistry } from "./pairing-registry.js";

/** A pairing body is a couple of short strings. Anything larger is not a
 * client we serve. */
const MAX_BODY_BYTES = 64 * 1024;

/** Each live session holds an MCP server, which in turn holds a WebSocket
 * fallback listener. Bounding them keeps a misbehaving client from opening
 * ports until the machine runs out. */
const MAX_SESSIONS = 8;

export type AgentAccessServerOptions = {
  policyFile: string;
  appVersion: string;
  pairings: PairingRegistry;
  port?: number;
  log?: (message: string, extra?: unknown) => void;
};

type Session = {
  principalId: string;
  transport: StreamableHTTPServerTransport;
  server: PwrGitMcpServer;
};

/** Loopback HTTP surface that lets a local agent reach PwrGit's MCP tools
 * without the operator hand-copying a token into a config file.
 *
 * Everything here is reachable from any process on the machine, and from any
 * web page the operator visits, so the two gates that matter are:
 *
 * - `isLoopbackRequest` rejects cross-origin browser traffic. The MCP
 *   Streamable HTTP spec requires Origin validation precisely because a page
 *   at evil.example can otherwise POST to 127.0.0.1 and drive a local server.
 * - `/mcp` requires a bearer token that only the consent sheet can mint, and
 *   re-reads the policy file on every call so a revoked session stops working
 *   without restarting anything.
 */
export class AgentAccessServer {
  private http: HttpServer | undefined;
  private readonly sessions = new Map<string, Session>();
  /** The requested port; 0 asks the OS to choose. */
  private readonly requestedPort: number;
  /** The port actually bound. Equals `requestedPort` in production, and is
   * what tests need when they ask for an ephemeral one. */
  private boundPort: number;
  private readonly log: (message: string, extra?: unknown) => void;

  constructor(private readonly options: AgentAccessServerOptions) {
    this.requestedPort = options.port ?? AGENT_ACCESS_PORT;
    this.boundPort = this.requestedPort;
    this.log = options.log ?? (() => undefined);
  }

  get port(): number {
    return this.boundPort;
  }

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.boundPort}${AGENT_ACCESS_MCP_PATH}`;
  }

  get listening(): boolean {
    return this.http?.listening === true;
  }

  async start(): Promise<void> {
    if (this.http !== undefined) return;
    const http = createServer((request, response) => {
      void this.handle(request, response).catch((cause) => {
        this.log("request failed", {
          message: cause instanceof Error ? cause.message : String(cause)
        });
        if (!response.headersSent) {
          this.json(response, 500, { error: "internal_error" });
        }
      });
    });
    this.http = http;
    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error): void => {
        this.http = undefined;
        reject(cause);
      };
      http.once("error", onError);
      http.listen(this.requestedPort, "127.0.0.1", () => {
        http.off("error", onError);
        const address = http.address();
        if (address !== null && typeof address === "object") {
          this.boundPort = address.port;
        }
        this.log("listening", { port: this.boundPort });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    for (const [sessionId, session] of this.sessions) {
      this.sessions.delete(sessionId);
      await session.server.close().catch(() => undefined);
    }
    if (http === undefined) return;
    await new Promise<void>((resolve) => http.close(() => resolve()));
    this.log("stopped");
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!isLoopbackRequest(request)) {
      this.json(response, 403, { error: "forbidden_origin" });
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.boundPort}`);

    if (url.pathname === AGENT_ACCESS_HEALTH_PATH && request.method === "GET") {
      const health: AgentAccessHealth = {
        protocol: AGENT_ACCESS_PROTOCOL,
        app: "PwrGit",
        version: this.options.appVersion,
        agentAccess: true,
        mcpUrl: this.mcpUrl
      };
      this.json(response, 200, health);
      return;
    }

    if (
      url.pathname === AGENT_ACCESS_PAIR_REQUEST_PATH
      && request.method === "POST"
    ) {
      const body = await this.readJson(request, response);
      if (body === undefined) return;
      const clientName = typeof body.clientName === "string" ? body.clientName : "";
      const requestedRoleId =
        typeof body.requestedRoleId === "string" ? body.requestedRoleId : undefined;
      try {
        this.json(
          response,
          200,
          this.options.pairings.request(clientName, requestedRoleId)
        );
      } catch (cause) {
        this.json(response, 400, {
          error: "invalid_request",
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
      return;
    }

    if (url.pathname === AGENT_ACCESS_PAIR_POLL_PATH && request.method === "GET") {
      const pairingId = url.searchParams.get("pairingId") ?? "";
      if (pairingId === "") {
        this.json(response, 400, { error: "missing_pairing_id" });
        return;
      }
      this.json(response, 200, this.options.pairings.poll(pairingId, this.mcpUrl));
      return;
    }

    if (url.pathname === AGENT_ACCESS_MCP_PATH) {
      await this.handleMcp(request, response);
      return;
    }

    this.json(response, 404, { error: "not_found" });
  }

  private async handleMcp(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const token = bearerToken(request);
    if (token === undefined) {
      response.setHeader("WWW-Authenticate", "Bearer");
      this.json(response, 401, { error: "missing_session_token" });
      return;
    }

    // Authorize before building anything, so a bad token cannot cost us a
    // server instance and a WebSocket port.
    const authorizer = new PolicyFileAuthorizer(this.options.policyFile, token);
    let principalId: string;
    try {
      principalId = (await authorizer.authorize()).sessionId;
    } catch (cause) {
      response.setHeader("WWW-Authenticate", "Bearer");
      this.json(response, 401, {
        error: "unauthorized",
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return;
    }

    const sessionId = header(request, "mcp-session-id");
    const existing = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (existing !== undefined) {
      if (existing.principalId !== principalId) {
        this.json(response, 403, { error: "session_principal_mismatch" });
        return;
      }
      await existing.transport.handleRequest(request, response);
      return;
    }
    if (sessionId !== undefined) {
      this.json(response, 404, { error: "unknown_session" });
      return;
    }

    // No session yet: this must be an initialize. Reading the body here means
    // handleRequest gets it passed in rather than re-reading a consumed stream.
    const body = await this.readJson(request, response);
    if (body === undefined) return;

    if (this.sessions.size >= MAX_SESSIONS) {
      this.json(response, 429, { error: "too_many_sessions" });
      return;
    }

    const server = await createPwrGitMcpServer({ authorizer });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        this.sessions.set(id, { transport, server, principalId });
        this.log("session opened", { sessionId: id });
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) this.sessions.delete(id);
      void server.close().catch(() => undefined);
      this.log("session closed", { sessionId: id });
    };
    // The SDK's transport classes declare optional members without an
    // explicit `| undefined`, which this project's exactOptionalPropertyTypes
    // rejects structurally. The runtime shape is correct.
    await server.mcp.connect(transport as unknown as Parameters<typeof server.mcp.connect>[0]);
    try {
      await transport.handleRequest(request, response, body);
    } finally {
      if (transport.sessionId === undefined) await server.close();
    }
  }

  private async readJson(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        this.json(response, 413, { error: "payload_too_large" });
        return undefined;
      }
      chunks.push(buffer);
    }
    if (size === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object") {
        this.json(response, 400, { error: "invalid_json" });
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch {
      this.json(response, 400, { error: "invalid_json" });
      return undefined;
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      // Nothing here is meant for a browser; say so rather than relying on
      // the caller to have no credentials to send.
      "cache-control": "no-store"
    });
    response.end(payload);
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = header(request, "authorization");
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/** DNS-rebinding and CSRF gate.
 *
 * A page on any website can issue requests to 127.0.0.1, and a hostname that
 * resolves to 127.0.0.1 defeats a Host check alone. So: a request carrying a
 * browser `Origin` is only served when that origin is itself loopback, and the
 * `Host` must name loopback too. A non-browser client (CLI, PwrAgent) sends no
 * Origin and passes on the Host check. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const host = headerValue(request.headers.host);
  if (host === undefined || !isLoopbackHost(host)) return false;
  const origin = headerValue(request.headers.origin);
  if (origin === undefined) return true;
  if (origin === "null") return false;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function isLoopbackHost(host: string): boolean {
  // Strip a port; an IPv6 literal keeps its brackets until the URL parse.
  const withoutPort = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? host);
  return isLoopbackHostname(withoutPort);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (normalized === "localhost") return true;
  if (normalized === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}
