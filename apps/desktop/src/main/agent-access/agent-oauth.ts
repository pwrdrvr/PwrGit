import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { MCP_AGENT_CAPABILITIES, type McpAgentCapability, type McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const TTL = 5 * 60_000;
const LIMIT = 64;
const opaque = () => randomBytes(32).toString("base64url");
export type ConsentRequest = {
  clientName: string;
  scopes: McpAgentCapability[];
  signal: AbortSignal;
};
export type ConsentDecision = { decision: "allow" | "deny"; sessionName: string; roleId: string };
export type RequestConsent = (request: ConsentRequest) => Promise<ConsentDecision>;

class Clients implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  constructor(private readonly file: string, private readonly policy: McpPolicyStore) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(saved) || saved.length > 256) throw new Error("Invalid OAuth client store");
      for (const value of saved) {
        const client = OAuthClientInformationFullSchema.parse(value);
        this.clients.set(client.client_id, client);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  getClient(id: string) { return this.clients.get(id); }
  registerClient: NonNullable<OAuthRegisteredClientsStore["registerClient"]> = async (input) => {
    // Public native clients, as in PwrSnap. Registration never grants access.
    const client: OAuthClientInformationFull = {
      ...input, client_id: opaque(), client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"]
    };
    delete client.client_secret;
    delete client.client_secret_expires_at;
    if (this.clients.size >= 256) {
      const approved = new Set(this.policy.snapshot().sessions.filter(s => s.revokedAt === null).map(s => s.oauth?.clientId));
      const evict = [...this.clients.keys()].find(id => !approved.has(id));
      if (evict === undefined) throw new InvalidRequestError("OAuth client limit reached");
      this.clients.delete(evict);
    }
    this.clients.set(client.client_id, client);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + ".tmp";
    writeFileSync(temporary, JSON.stringify([...this.clients.values()]), { mode: 0o600 });
    renameSync(temporary, this.file);
    return client;
  };
}

type Code = { clientId: string; params: AuthorizationParams; decision: ConsentDecision; scopes: McpAgentCapability[]; expires: number };
type BrowserApproval = { controller: AbortController; expires: number; redirect?: string };
export class AgentOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, Code>();
  private readonly approvals = new Map<string, BrowserApproval>();
  constructor(private readonly options: {
    policy: McpPolicyStore; clientsFile: string; resource: URL; requestConsent: RequestConsent; onChanged: () => void;
  }) {
    this.clientsStore = new Clients(options.clientsFile, options.policy);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    this.prune();
    this.validateResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError("A valid S256 challenge is required");
    const scopes = params.scopes?.length ? params.scopes : ["repository.roots.read", "repository.checkout.locate", "repository.metadata.read"];
    if (!scopes.every(s => (MCP_AGENT_CAPABILITIES as readonly string[]).includes(s))) throw new InvalidScopeError("Unknown PwrGit permission");
    if (this.approvals.size >= LIMIT || this.codes.size >= LIMIT) throw new InvalidRequestError("Too many pending approvals");
    const id = opaque();
    const record: BrowserApproval = { controller: new AbortController(), expires: Date.now() + TTL };
    this.approvals.set(id, record);
    const timer = setTimeout(() => {
      record.controller.abort();
      this.approvals.delete(id);
    }, TTL);
    timer.unref();
    const finish = (decision: ConsentDecision) => {
      clearTimeout(timer);
      if (record.controller.signal.aborted || Date.now() >= record.expires) return;
      const callback = new URL(params.redirectUri);
      if (params.state !== undefined) callback.searchParams.set("state", params.state);
      const role = this.options.policy.snapshot().roles.find(r => r.id === decision.roleId);
      if (decision.decision !== "allow" || !role ||
          !decision.sessionName.trim() || decision.sessionName.trim().length > 200 ||
          !role.permissions.every(s => scopes.includes(s))) {
        callback.searchParams.set("error", "access_denied");
      } else {
        const code = opaque();
        this.codes.set(code, {
          clientId: client.client_id, params, decision,
          scopes: [...role.permissions], expires: Date.now() + TTL
        });
        callback.searchParams.set("code", code);
      }
      record.redirect = callback.href;
    };
    void this.options.requestConsent({
      clientName: client.client_name?.trim() || "Local MCP client",
      scopes: scopes as McpAgentCapability[], signal: record.controller.signal
    }).then(finish).catch(() => finish({ decision: "deny", sessionName: "", roleId: "" }));
    this.waitingPage(response, id);
  }

  status(id: string, response: Response): void {
    this.prune();
    const record = this.approvals.get(id);
    if (!record) { response.status(404).send("Approval expired. Start a new PwrGit login."); return; }
    if (!record.redirect) { this.waitingPage(response, id); return; }
    this.approvals.delete(id);
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, record.redirect);
  }

  private waitingPage(response: Response, id: string) {
    // No browser form or script can approve access. The opaque status URL only
    // retrieves a PKCE-bound redirect after the trusted native window decides.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=/authorize/status?id=${id}"><title>Continue in PwrGit</title></head><body><h1>Continue in PwrGit</h1><p>Review the Session Name and permissions in PwrGit’s approval window.</p></body></html>`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.requireCode(client, code).params.codeChallenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirect?: string, resource?: URL): Promise<OAuthTokens> {
    const record = this.requireCode(client, code);
    if (redirect !== record.params.redirectUri) throw new InvalidGrantError("Redirect does not match");
    this.validateResource(resource);
    this.codes.delete(code);
    const role = this.options.policy.snapshot().roles.find(r => r.id === record.decision.roleId);
    if (!role || !role.permissions.every(s => record.scopes.includes(s))) throw new InvalidGrantError("Approved role changed; authorize again");
    const issued = this.options.policy.createSession(record.decision.sessionName, record.decision.roleId, {
      clientId: client.client_id, scopes: record.scopes
    });
    this.options.onChanged();
    return { access_token: issued.token, token_type: "bearer", scope: record.scopes.join(" ") };
  }
  async exchangeRefreshToken(): Promise<OAuthTokens> { throw new InvalidGrantError("PwrGit tokens do not expire or refresh"); }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const auth = this.options.policy.authorize(token);
      const session = this.options.policy.snapshot().sessions.find(s => s.id === auth.sessionId);
      if (!session?.oauth) throw new Error("OAuth Session required");
      return { token, clientId: session.oauth.clientId, scopes: [...auth.capabilities], resource: this.options.resource };
    } catch { throw new InvalidTokenError("Invalid or revoked PwrGit Session"); }
  }
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    try {
      const auth = this.options.policy.authorize(request.token);
      const session = this.options.policy.snapshot().sessions.find(s => s.id === auth.sessionId);
      if (session?.oauth?.clientId === client.client_id) {
        this.options.policy.revokeSession(auth.sessionId);
        this.options.onChanged();
      }
    } catch { /* RFC 7009: unknown/revoked tokens also succeed. */ }
  }
  close() {
    for (const record of this.approvals.values()) record.controller.abort();
    this.approvals.clear();
    this.codes.clear();
  }
  private validateResource(resource?: URL) {
    if (resource?.href !== this.options.resource.href) throw new InvalidTargetError("resource must be " + this.options.resource.href);
  }
  private requireCode(client: OAuthClientInformationFull, code: string): Code {
    this.prune();
    const record = this.codes.get(code);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return record;
  }
  private prune() {
    const now = Date.now();
    for (const [id, record] of this.codes) if (record.expires <= now) this.codes.delete(id);
    for (const [id, record] of this.approvals) if (record.expires <= now) {
      record.controller.abort();
      this.approvals.delete(id);
    }
  }
}
