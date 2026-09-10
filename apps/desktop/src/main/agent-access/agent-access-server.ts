import { createServer, type Server as HttpServer } from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpPolicyStore, PolicyFileAuthorizer, MCP_AGENT_CAPABILITIES } from "@pwrgit/mcp-server/access-policy";
import { createPwrGitMcpServer, type PwrGitMcpServer, type CommandRunner, type AppBackend } from "@pwrgit/mcp-server";
import { AGENT_ACCESS_PORT } from "@pwrgit/mcp-server/agent-access-protocol";
import { AgentOAuth, type RequestConsent } from "./agent-oauth";

export type AgentAccessServerOptions = {
  appBackend?: AppBackend;
  runner: CommandRunner;
  policyFile: string;
  clientsFile: string;
  requestConsent: RequestConsent;
  onChanged: () => void;
  port?: number;
  log?: (message: string, extra?: unknown) => void;
};

/** The wire transport is stateless, as in PwrSnap. Per-principal tool state
 * keeps PwrGit's watch resources and WebSocket fallback alive across POSTs.
 * Requests on a principal are serialized before attaching a fresh transport. */
type Principal = { server: Promise<PwrGitMcpServer>; tail: Promise<void>; pending: number };
export class AgentAccessServer {
  private http: HttpServer | undefined;
  private oauth: AgentOAuth | undefined;
  private boundPort: number;
  private reclamation: Promise<void> = Promise.resolve();
  private readonly principals = new Map<string, Principal>();
  constructor(private readonly options: AgentAccessServerOptions) {
    this.boundPort = options.port ?? AGENT_ACCESS_PORT;
  }
  get port() { return this.boundPort; }
  get mcpUrl() { return `http://127.0.0.1:${this.boundPort}/mcp`; }
  get listening() { return this.http?.listening === true; }

  async start(): Promise<void> {
    if (this.http) return;
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      // Match the bound authority exactly to stop DNS rebinding. Browser
      // origins are limited to loopback; opaque (sandboxed) origins fail.
      if (req.headers.host !== `127.0.0.1:${this.boundPort}` || !allowedOrigin(req.headers.origin)) {
        res.status(403).json({ error: "forbidden_origin" }); return;
      }
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    const http = createServer(app);
    this.http = http;
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(this.boundPort, "127.0.0.1", () => {
          http.off("error", reject);
          const address = http.address();
          if (address && typeof address !== "string") this.boundPort = address.port;
          resolve();
        });
      });
      const resource = new URL(this.mcpUrl);
      const issuer = new URL(resource.origin);
      const oauth = new AgentOAuth({
        policy: new McpPolicyStore(this.options.policyFile),
        clientsFile: this.options.clientsFile,
        resource, requestConsent: this.options.requestConsent, onChanged: this.options.onChanged
      });
      this.oauth = oauth;
      app.get("/authorize/status", (req, res) => oauth.status(typeof req.query.id === "string" ? req.query.id : "", res));
      app.all("/authorize", (req, res, next) => {
        if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).end(); return; }
        // URL parameters can request authorization, never decide consent.
        if (["decision", "pwrgit_decision", "capability", "consent_transaction"].some(k => k in req.query)) {
          res.status(400).json({ error: "invalid_request" }); return;
        }
        next();
      });
      app.use("/authorize", authorizationHandler({ provider: oauth }));
      app.use("/register", clientRegistrationHandler({ clientsStore: oauth.clientsStore, clientIdGeneration: false }));
      app.use("/token", tokenHandler({ provider: oauth }));
      app.use("/revoke", revocationHandler({ provider: oauth }));
      app.use(mcpAuthMetadataRouter({
        resourceServerUrl: resource, resourceName: "PwrGit", scopesSupported: [...MCP_AGENT_CAPABILITIES],
        oauthMetadata: {
          issuer: issuer.href,
          authorization_endpoint: new URL("/authorize", issuer).href,
          token_endpoint: new URL("/token", issuer).href,
          registration_endpoint: new URL("/register", issuer).href,
          revocation_endpoint: new URL("/revoke", issuer).href,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [...MCP_AGENT_CAPABILITIES]
        }
      }));
      app.all("/mcp", (req, res, next) => {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); res.status(405).end(); return; }
        next();
      });
      app.post("/mcp", express.json({ limit: "64kb" }), (req, res, next) => {
        void this.handleMcp(req, res, oauth).catch(next);
      });
      app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
      app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const status = (error as { status?: number }).status;
        if (!res.headersSent) res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({ error: "request_failed" });
        else res.end();
      });
    } catch (cause) {
      await this.stop();
      throw cause;
    }
  }

  private async handleMcp(req: Request, res: Response, oauth: AgentOAuth) {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization?.trim() ?? "")?.[1];
    let principalId: string;
    try {
      if (!token) throw new Error("Missing token");
      await oauth.verifyAccessToken(token);
      principalId = new McpPolicyStore(this.options.policyFile).authorize(token).sessionId;
    } catch {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${new URL(this.mcpUrl).origin}/.well-known/oauth-protected-resource/mcp"`);
      res.status(401).json({ error: "unauthorized" }); return;
    }
    if (!this.principals.has(principalId)) await this.reclaimRevokedPrincipals();
    let principal = this.principals.get(principalId);
    if (!principal) {
      if (this.principals.size >= 16) { res.status(429).json({ error: "too_many_clients" }); return; }
      principal = {
        server: createPwrGitMcpServer({
          authorizer: new PolicyFileAuthorizer(this.options.policyFile, token!),
          runner: this.options.runner,
          ...(this.options.appBackend ? { appBackend: this.options.appBackend } : {}),
          supportsSubscriptions: false
        }),
        tail: Promise.resolve(), pending: 0
      };
      this.principals.set(principalId, principal);
      void principal.server.catch(() => this.principals.delete(principalId));
    }
    if (principal.pending >= 16) { res.status(429).json({ error: "too_many_requests" }); return; }
    principal.pending++;
    const state = principal;
    const operation = state.tail.then(async () => {
      // Revocation while a request was queued must still fail closed.
      await oauth.verifyAccessToken(token!);
      const server = await state.server;
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.mcp.connect(transport as unknown as Parameters<typeof server.mcp.connect>[0]);
      try { await transport.handleRequest(req, res, req.body); }
      finally { await transport.close(); }
    });
    state.tail = operation.catch(() => undefined).finally(() => { state.pending--; });
    await operation;
  }

  private reclaimRevokedPrincipals(): Promise<void> {
    // Serialize admission cleanup so concurrent clients cannot reuse a slot
    // before its old server and WebSocket listener have finished closing.
    const operation = this.reclamation.then(async () => {
      const active = new Set(new McpPolicyStore(this.options.policyFile).snapshot().sessions
        .filter(session => session.revokedAt === null).map(session => session.id));
      const retired: Principal[] = [];
      for (const [id, principal] of this.principals) {
        if (active.has(id)) continue;
        this.principals.delete(id);
        retired.push(principal);
      }
      await Promise.allSettled(retired.map(async principal => {
        await principal.tail;
        await (await principal.server).close();
      }));
    });
    this.reclamation = operation.catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    this.oauth?.close();
    this.oauth = undefined;
    const http = this.http;
    this.http = undefined;
    // Terminate active HTTP connections before draining queued MCP calls.
    http?.closeAllConnections();
    await this.reclamation;
    await Promise.all([...this.principals.values()].map(async p => {
      await p.tail;
      await (await p.server).close();
    })).catch(() => undefined);
    this.principals.clear();
    if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  }
}

export function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}
