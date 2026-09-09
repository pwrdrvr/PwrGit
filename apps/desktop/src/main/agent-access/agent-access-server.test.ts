import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpPolicyStore, MCP_AGENT_CAPABILITIES } from "@pwrgit/mcp-server/access-policy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentAccessServer, allowedOrigin } from "./agent-access-server";
import type { ConsentDecision, RequestConsent } from "./agent-oauth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(decision: ConsentDecision = { decision: "allow", sessionName: "Test agent", roleId: "builtin.live-status" }, requestConsent?: RequestConsent) {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-oauth-"));
  const policyFile = join(dir, "policy.json");
  const policy = new McpPolicyStore(policyFile);
  policy.initialize();
  const options = { policyFile, clientsFile: join(dir, "clients.json"), port: 0,
    requestConsent: requestConsent ?? (async () => decision), onChanged: () => undefined };
  const server = new AgentAccessServer(options);
  await server.start();
  cleanups.push(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
  const base = new URL(server.mcpUrl).origin;
  const register = async () => {
    const response = await fetch(base + "/register", {
      method: "POST", headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ client_name: "Test agent", redirect_uris: ["http://127.0.0.1:19876/callback"], token_endpoint_auth_method: "none" })
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { client_id: string };
    expect(body).not.toHaveProperty("client_secret");
    return body.client_id;
  };
  const authorize = async (clientId: string, patch: Record<string, string> = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: "http://127.0.0.1:19876/callback", response_type: "code",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      resource: server.mcpUrl, scope: MCP_AGENT_CAPABILITIES.join(" "), state: "state-sentinel", ...patch
    });
    const response = await fetch(base + "/authorize?" + query, { redirect: "manual", headers: { connection: "close" } });
    return { response, verifier, query };
  };
  const approvedCode = async (clientId: string) => {
    const { response, verifier } = await authorize(clientId);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toMatch(/<script|<form|<input|<button/i);
    const status = html.match(/url=([^"]+)/)![1]!;
    const redirect = await fetch(base + status, { redirect: "manual", headers: { connection: "close" } });
    expect(redirect.status).toBe(302);
    const callback = new URL(redirect.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("state-sentinel");
    return { code: callback.searchParams.get("code")!, verifier, callback };
  };
  const exchange = (clientId: string, code: string, verifier: string, patch: Record<string, string> = {}) => fetch(base + "/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
    body: new URLSearchParams({ client_id: clientId, grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:19876/callback", resource: server.mcpUrl, ...patch })
  });
  const login = async () => {
    const clientId = await register();
    const { code, verifier } = await approvedCode(clientId);
    const response = await exchange(clientId, code, verifier);
    expect(response.status).toBe(200);
    const body = await response.json() as { access_token: string };
    return { clientId, token: body.access_token };
  };
  return { server, base, policy, options, register, authorize, approvedCode, exchange, login };
}

describe("PwrSnap-compatible OAuth MCP surface", () => {
  it("advertises DCR, PKCE S256, public clients and no refresh grant", async () => {
    const { base } = await setup();
    const metadata = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
    expect(metadata).toMatchObject({ grant_types_supported: ["authorization_code"], token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"], registration_endpoint: base + "/register" });
    const resource = await (await fetch(base + "/.well-known/oauth-protected-resource/mcp")).json();
    expect(resource).toMatchObject({ resource: base + "/mcp", authorization_servers: [base + "/"] });
    const unauthenticated = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: "{}" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(base + "/.well-known/oauth-protected-resource/mcp");
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await fetch(base + "/mcp", { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await fetch(base + "/pair/request", { method: "POST" })).status).toBe(404);
    expect((await fetch(base + "/pair/poll")).status).toBe(404);
    expect((await fetch(base + "/authorize", { method: "POST" })).status).toBe(405);
  });

  it("completes discovery, dynamic registration and PKCE with the standard OAuth client", async () => {
    const { server, base } = await setup();
    let clientInfo: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier = "";
    let authorizationUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1:19876/callback",
      clientMetadata: { client_name: "SDK OAuth client", redirect_uris: ["http://127.0.0.1:19876/callback"],
        token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
        scope: MCP_AGENT_CAPABILITIES.join(" ") },
      clientInformation: () => clientInfo,
      saveClientInformation: value => { clientInfo = value; },
      tokens: () => tokens,
      saveTokens: value => { tokens = value; },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => verifier,
      redirectToAuthorization: url => { authorizationUrl = url; }
    };
    expect(await auth(provider, { serverUrl: server.mcpUrl })).toBe("REDIRECT");
    expect(authorizationUrl).toBeDefined();
    const page = await (await fetch(authorizationUrl!, { redirect: "manual" })).text();
    const status = page.match(/url=([^"]+)/)![1]!;
    const redirect = await fetch(base + status, { redirect: "manual" });
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;
    expect(await auth(provider, { serverUrl: server.mcpUrl, authorizationCode: code })).toBe("AUTHORIZED");
    expect(tokens).not.toHaveProperty("refresh_token");
    const client = new Client({ name: "sdk-oauth", version: "1" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), { authProvider: provider });
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      const capabilities = await client.callTool({ name: "pwrgit_live_status_capabilities", arguments: {} });
      expect(capabilities.structuredContent).toMatchObject({ mcp: { transport: "streamable_http", resourceSubscriptions: { supported: false } } });
      const again = await client.callTool({ name: "pwrgit_live_status_capabilities", arguments: {} });
      expect(again.structuredContent).toEqual(capabilities.structuredContent);
    } finally { await client.close(); }
  });

  it("authenticates a standard SDK client across stateless POSTs and revokes immediately", async () => {
    const { server, policy, login } = await setup();
    const { token } = await login();
    const client = new Client({ name: "integration", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), { requestInit: { headers: { authorization: "Bearer " + token } } });
    try {
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      expect(transport.sessionId).toBeUndefined();
      expect((await client.listTools()).tools.some(t => t.name === "pwrgit_repository_info")).toBe(true);
      expect((await client.listResources()).resources).toBeDefined();
      const result = await client.callTool({ name: "pwrgit_repository_info", arguments: { path: process.cwd() } });
      expect(result.isError ?? false).toBe(false);
      expect(JSON.stringify(result.content)).toContain("canonicalRemote");
      policy.revokeSession(policy.snapshot().sessions[0]!.id);
      await expect(client.listTools()).rejects.toThrow();
    } finally { await client.close(); }
  });

  it("rejects wrong PKCE, code reuse, wrong clients, wrong redirects and wrong resources", async () => {
    const { register, approvedCode, exchange, policy } = await setup();
    const client = await register();
    const other = await register();
    const { code, verifier } = await approvedCode(client);
    for (const [id, verify, patch] of [
      [client, "incorrect-verifier", {}], [other, verifier, {}],
      [client, verifier, { redirect_uri: "http://127.0.0.1:19876/other" }],
      [client, verifier, { resource: "http://127.0.0.1:1/mcp" }]
    ] as const) expect((await exchange(id, code, verify, patch)).status).toBe(400);
    expect(policy.snapshot().sessions).toHaveLength(0);
    expect((await exchange(client, code, verifier)).status).toBe(200);
    expect((await exchange(client, code, verifier)).status).toBe(400);
    expect(policy.snapshot().sessions).toHaveLength(1);
  });

  it("denial never creates a Session", async () => {
    const { register, approvedCode, policy } = await setup({ decision: "deny", sessionName: "", roleId: "" });
    const { callback } = await approvedCode(await register());
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(policy.snapshot().sessions).toHaveLength(0);
  });

  it("validates authorization redirect, scope, resource and PKCE before opening consent", async () => {
    let prompts = 0;
    const { register, authorize } = await setup(undefined, async () => {
      prompts++; return { decision: "deny", sessionName: "", roleId: "" };
    });
    const client = await register();
    for (const patch of [
      { redirect_uri: "https://attacker.example/callback" }, { scope: "unknown" },
      { resource: "http://127.0.0.1:1/mcp" }, { code_challenge_method: "plain" }
    ]) {
      const { response } = await authorize(client, patch);
      expect([302, 400]).toContain(response.status);
    }
    expect(prompts).toBe(0);
  });

  it("persists client registrations and OAuth sessions across listener restarts", async () => {
    const { server, options, login, policy } = await setup();
    const { clientId, token } = await login();
    const port = server.port;
    await server.stop();
    const next = new AgentAccessServer({ ...options, port });
    await next.start();
    try {
      const response = await new Promise<{ status: number | undefined; session: string | string[] | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest(next.mcpUrl, { method: "POST", agent: false, headers: {
          authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream"
        } }, result => {
          let body = "";
          result.setEncoding("utf8");
          result.on("data", chunk => { body += chunk; });
          result.on("end", () => resolve({ status: result.statusCode, session: result.headers["mcp-session-id"], body }));
        });
        request.on("error", reject);
        request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "restart", version: "1" }
        } }));
      });
      expect(response.status).toBe(200);
      expect(response.session).toBeUndefined();
      expect(response.body).toContain("PwrGit");
      const revoked = await fetch(new URL("/revoke", next.mcpUrl), { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" }, body: new URLSearchParams({ client_id: clientId, token }) });
      expect(revoked.status).toBe(200);
      expect(policy.snapshot().sessions[0]?.revokedAt).not.toBeNull();
    } finally { await next.stop(); }
  });

  it("expires unredeemed authorization codes and cancels pending native approval on stop", async () => {
    const first = await setup();
    const client = await first.register();
    const { code, verifier } = await first.approvedCode(client);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      expect((await first.exchange(client, code, verifier)).status).toBe(400);
      expect(first.policy.snapshot().sessions).toHaveLength(0);
    } finally { vi.useRealTimers(); }

    let signal: AbortSignal | undefined;
    const second = await setup(undefined, request => {
      signal = request.signal;
      return new Promise(resolve => request.signal.addEventListener("abort", () => resolve({ decision: "deny", sessionName: "", roleId: "" }), { once: true }));
    });
    const pending = await second.authorize(await second.register());
    await pending.response.text();
    expect(signal?.aborted).toBe(false);
    await second.server.stop();
    expect(signal?.aborted).toBe(true);
    expect(second.policy.snapshot().sessions).toHaveLength(0);
  });

  it("prevents a later role assignment from exceeding OAuth consent", async () => {
    const { policy, login } = await setup({ decision: "allow", sessionName: "Reader", roleId: "builtin.local-reader" });
    const { token } = await login();
    const session = policy.snapshot().sessions[0]!;
    policy.assignRole(session.id, "builtin.live-status");
    expect(policy.authorize(token).capabilities).toEqual(["repository.roots.read", "repository.checkout.locate", "repository.metadata.read"]);
    expect(() => policy.authorize(token, { capabilities: ["forge.status.read"] })).toThrow("does not grant");
  });

  it("rejects legacy manually minted tokens on HTTP", async () => {
    const { server, policy } = await setup();
    const credential = policy.createSession("Legacy", "builtin.discovery");
    const response = await fetch(server.mcpUrl, { method: "POST", headers: {
      authorization: "Bearer " + credential.token, "content-type": "application/json"
    }, body: "{}" });
    expect(response.status).toBe(401);
  });

  it("rejects remote/opaque browser origins and rebinding hosts", async () => {
    const { base } = await setup();
    for (const origin of ["null", "https://attacker.example"]) {
      expect(allowedOrigin(origin)).toBe(false);
      expect((await fetch(base + "/.well-known/oauth-authorization-server", { headers: { origin } })).status).toBe(403);
    }
    const status = await new Promise<number | undefined>(resolve => {
      const req = httpRequest(base + "/.well-known/oauth-authorization-server", { headers: { host: "attacker.example" } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.end();
    });
    expect(status).toBe(403);
  });
});
