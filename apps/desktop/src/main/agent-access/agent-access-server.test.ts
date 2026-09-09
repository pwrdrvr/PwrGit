import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAccessServer, isLoopbackRequest } from "./agent-access-server";
import { PairingRegistry } from "./pairing-registry";

const cleanup: string[] = [];
const servers: AgentAccessServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function policyStore(): { store: McpPolicyStore; file: string } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-agent-access-"));
  cleanup.push(root);
  const file = join(root, "mcp-policy.json");
  const store = new McpPolicyStore(file);
  store.initialize();
  return { store, file };
}

async function startServer(): Promise<{
  server: AgentAccessServer;
  base: string;
  pairings: PairingRegistry;
  store: McpPolicyStore;
}> {
  const { store, file } = policyStore();
  const pairings = new PairingRegistry(store, () => undefined);
  // Port 0 lets the OS pick, so concurrent test files never collide on the
  // fixed production port.
  const server = new AgentAccessServer({
    policyFile: file,
    appVersion: "0.0.0-test",
    pairings,
    port: 0
  });
  servers.push(server);
  await server.start();
  const port = new URL(server.mcpUrl).port;
  return { server, base: `http://127.0.0.1:${port}`, pairings, store };
}

describe("loopback origin gate", () => {
  it("serves a non-browser client that sends no origin", () => {
    expect(isLoopbackRequest(fakeRequest({ host: "127.0.0.1:51731" }))).toBe(true);
  });

  it("serves a loopback browser origin", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://[::1]:8080"
    ]) {
      expect(
        isLoopbackRequest(fakeRequest({ host: "127.0.0.1:51731", origin }))
      ).toBe(true);
    }
  });

  it("rejects a remote page reaching for the loopback port", () => {
    // The DNS-rebinding case: the browser resolved evil.example to 127.0.0.1,
    // so Host looks fine and only Origin gives it away.
    expect(
      isLoopbackRequest(
        fakeRequest({ host: "127.0.0.1:51731", origin: "https://evil.example" })
      )
    ).toBe(false);
  });

  it("rejects a host header that is not loopback", () => {
    expect(isLoopbackRequest(fakeRequest({ host: "pwrgit.example" }))).toBe(false);
  });

  it("rejects opaque browser origins and missing hosts", () => {
    expect(isLoopbackRequest(fakeRequest({ host: "127.0.0.1", origin: "null" }))).toBe(false);
    expect(isLoopbackRequest(fakeRequest({}))).toBe(false);
  });

  it("rejects an unparseable origin rather than defaulting to allow", () => {
    expect(
      isLoopbackRequest(fakeRequest({ host: "127.0.0.1", origin: "not a url" }))
    ).toBe(false);
  });
});

describe("agent access server", () => {
  it("answers health with a stable protocol identity", async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protocol: "pwrgit.agent-access/v1",
      app: "PwrGit",
      agentAccess: true
    });
  });

  it("refuses a cross-origin request", async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/health`, {
      headers: { origin: "https://evil.example" }
    });
    expect(response.status).toBe(403);
  });

  it("requires a bearer token on the MCP endpoint", async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects a token that is not in the policy", async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer pgmcp_not-a-real-token"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
    });
    expect(response.status).toBe(401);
  });

  it("hands out a token only after the operator approves", async () => {
    const { base, pairings, store } = await startServer();
    const ticket = (await (
      await fetch(`${base}/pair/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientName: "Claude Code" })
      })
    ).json()) as { pairingId: string };
    expect(ticket.pairingId).toMatch(/^pair_/u);

    const before = (await (
      await fetch(`${base}/pair/poll?pairingId=${ticket.pairingId}`)
    ).json()) as { status: string };
    expect(before.status).toBe("pending");
    expect(pairings.pending()).toHaveLength(1);

    pairings.approve(ticket.pairingId, "builtin.local-reader");

    const after = (await (
      await fetch(`${base}/pair/poll?pairingId=${ticket.pairingId}`)
    ).json()) as { status: string; token?: string };
    expect(after.status).toBe("approved");
    expect(after.token).toMatch(/^pgmcp_/u);

    // The token is handed out once; a replayed poll gets nothing.
    const replay = (await (
      await fetch(`${base}/pair/poll?pairingId=${ticket.pairingId}`)
    ).json()) as { status: string };
    expect(replay.status).toBe("expired");
  });

  it("reports a denied pairing without minting a session", async () => {
    const { base, pairings, store } = await startServer();
    const ticket = (await (
      await fetch(`${base}/pair/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientName: "Something" })
      })
    ).json()) as { pairingId: string };
    pairings.deny(ticket.pairingId);
    const result = (await (
      await fetch(`${base}/pair/poll?pairingId=${ticket.pairingId}`)
    ).json()) as { status: string };
    expect(result.status).toBe("denied");
    expect(store.snapshot().sessions).toHaveLength(0);
  });

  it("serves MCP tools to an approved token", async () => {
    const { base, pairings, store } = await startServer();
    const ticket = (await (
      await fetch(`${base}/pair/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientName: "Probe" })
      })
    ).json()) as { pairingId: string };
    pairings.approve(ticket.pairingId, "builtin.live-status");
    const approved = (await (
      await fetch(`${base}/pair/poll?pairingId=${ticket.pairingId}`)
    ).json()) as { token: string };

    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${approved.token}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" }
        }
      })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    const text = await response.text();
    expect(text).toContain("PwrGit");
    const sessionId = response.headers.get("mcp-session-id")!;
    const other = store.createSession("Other client", "builtin.local-reader");
    const post = (token: string) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    });
    const invalid = await post("pgmcp_invalid");
    expect(invalid.status).toBe(401);
    await invalid.text();
    const wrongPrincipal = await post(other.token);
    expect(wrongPrincipal.status).toBe(403);
    await wrongPrincipal.text();
    const valid = await post(approved.token);
    expect(valid.status).toBe(200);
    await valid.text();
    const principal = store.snapshot().sessions.find((session) => session.name === "Probe")!;
    store.revokeSession(principal.id);
    const revoked = await post(approved.token);
    expect(revoked.status).toBe(401);
    await revoked.text();
  });
});
