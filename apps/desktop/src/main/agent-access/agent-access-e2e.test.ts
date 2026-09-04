import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAccessServer } from "./agent-access-server";
import { PairingRegistry } from "./pairing-registry";

const run = promisify(execFile);
const cleanup: string[] = [];
const servers: AgentAccessServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The whole third-party path in one test: a client asks, the operator
 * approves, and the credential that comes back actually drives the tools.
 *
 * The unit tests cover each half; this is the one that would have caught the
 * halves not fitting together. */
describe("agent access end to end", () => {
  it("pairs a client and serves it real repository data", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-e2e-"));
    cleanup.push(root);
    const policyFile = join(root, "mcp-policy.json");
    const store = new McpPolicyStore(policyFile);
    store.initialize();

    const pairings = new PairingRegistry(store, () => undefined);
    const server = new AgentAccessServer({
      policyFile,
      appVersion: "0.0.0-test",
      pairings,
      port: 0
    });
    servers.push(server);
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    // 1. The client asks for access.
    const ticket = (await (
      await fetch(`${base}/pair/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientName: "Claude Code" })
      })
    ).json()) as { pairingId: string };

    // 2. The operator sees it in the consent sheet and approves.
    expect(pairings.pending()).toMatchObject([{ clientName: "Claude Code" }]);
    pairings.approve(ticket.pairingId, "builtin.live-status");

    // 3. The client collects its credential.
    const approved = (await (
      await fetch(`${base}/pair/poll?pairingId=${ticket.pairingId}`)
    ).json()) as { status: string; token: string; mcpUrl: string };
    expect(approved.status).toBe("approved");

    // 4. That credential drives the MCP tools over the loopback endpoint.
    const client = new Client(
      { name: "e2e", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(new URL(approved.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${approved.token}` } }
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("pwrgit_repository_info");

      const result = await client.callTool({
        name: "pwrgit_repository_info",
        arguments: { path: process.cwd() }
      });
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toMatchObject({
        canonicalRemote: { provider: "github", path: "pwrdrvr/PwrGit" }
      });
    } finally {
      await client.close().catch(() => undefined);
    }

    // 5. Revoking the session cuts off a new connection without a restart.
    const session = store.snapshot().sessions[0];
    expect(session).toBeDefined();
    store.revokeSession(session!.id);
    const afterRevoke = await fetch(`${base}/mcp`, {
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
          clientInfo: { name: "e2e", version: "1.0.0" }
        }
      })
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("drives the same handshake through the shipped CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-e2e-cli-"));
    cleanup.push(root);
    const policyFile = join(root, "mcp-policy.json");
    const store = new McpPolicyStore(policyFile);
    store.initialize();

    const pairings = new PairingRegistry(store, () => undefined);
    const server = new AgentAccessServer({
      policyFile,
      appVersion: "0.0.0-test",
      pairings,
      port: 0
    });
    servers.push(server);
    await server.start();

    // Approve whatever shows up, the way a human would a moment later.
    const approver = setInterval(() => {
      for (const pending of pairings.pending()) {
        pairings.approve(pending.pairingId, "builtin.local-reader");
      }
    }, 25);

    try {
      const bin = join(
        __dirname,
        "../../../../../packages/mcp-server/dist/bin.js"
      );
      const { stdout } = await run(process.execPath, [
        bin,
        "pair",
        "--client",
        "CLI probe",
        "--port",
        String(server.port),
        "--format",
        "mcp-json"
      ]);
      const config = JSON.parse(stdout) as {
        mcpServers: { pwrgit: { env: Record<string, string> } };
      };
      expect(config.mcpServers.pwrgit.env.PWRGIT_MCP_SESSION_TOKEN).toMatch(
        /^pgmcp_/u
      );
      expect(config.mcpServers.pwrgit.env.PWRGIT_MCP_POLICY_FILE).toBe(policyFile);
      expect(store.snapshot().sessions).toMatchObject([{ name: "CLI probe" }]);
    } finally {
      clearInterval(approver);
    }
  });
});
