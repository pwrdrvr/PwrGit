import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUILT_IN_MCP_ROLES, McpPolicyStore } from "@pwrgit/mcp-server/access-policy";
import { runCommand } from "@pwrgit/mcp-server";
vi.mock("electron", () => ({ app: {} }));
import { AgentAccessServer } from "./agent-access-server";
const executable = fileURLToPath(new URL("../../../build/mcp/" + (process.platform === "win32" ? "pwrgit-mcp.exe" : "pwrgit-mcp"), import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(approve = true) {
  const directory = mkdtempSync(join(tmpdir(), "pg-mcp-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\pg-test-${directory.split(/[\\/]/).pop()}` : join(directory, "m.sock");
  const policy = new McpPolicyStore(join(directory, "policy.json")); policy.initialize();
  const consent = vi.fn(async () => ({ decision: approve ? "allow" as const : "deny" as const, sessionName: "Fixture host", roleId: "builtin.discovery" }));
  const server = new AgentAccessServer({ desktopVersion: "99.2.3", executable, endpoint, policyFile: join(directory, "policy.json"),
    runner: runCommand, requestConsent: consent, onChanged: () => undefined,
    appBackend: { catalog: async () => ({ profiles: [], repositories: [], activeProfileId: null }), open: async () => undefined, refresh: async () => undefined },
  });
  cleanups.push(async () => { await server.stop(); rmSync(directory, { recursive: true, force: true }); });
  await server.start();
  return { server, policy, consent, endpoint };
}
async function host(endpoint: string, args: string[] = []) {
  const client = new Client({ name: "Fixture", version: "0.0.1" });
  const transport = new StdioClientTransport({ command: executable, args: ["--endpoint", endpoint, ...args], stderr: "pipe" });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return { client, transport };
}
function http(endpoint: string, token: string, body?: unknown, session?: string, method = "POST") {
  const data = body === undefined ? "" : JSON.stringify(body);
  return new Promise<{ status: number; session: string | undefined; body: string }>((resolve, reject) => {
    const req = request({ socketPath: endpoint, path: "/mcp", method,
      agent: false,
      headers: { host: "local", authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(data), ...(session ? { "mcp-session-id": session } : {}) }
    }, res => {
      let output = ""; res.on("data", chunk => { output += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode!, session: res.headers["mcp-session-id"] as string | undefined, body: output }));
    });
    req.on("error", reject); req.end(data);
  });
}
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "HTTP fixture", version: "0.0.1" } } };

it("the running desktop owns identity and discovery across independently released native relays", async () => {
  const { server, endpoint, consent, policy } = await fixture();
  expect(server.mcpUrl).toMatch(/^(unix|pipe):\/\//);
  const { client } = await host(endpoint);
  expect(client.getServerVersion()).toEqual({ name: "PwrGit", version: "99.2.3" });
  const tools = (await client.listTools()).tools;
  expect(tools.map(tool => tool.name)).toContain("pwrgit_app_profiles");
  const metadata = tools.find(tool => tool.name === "pwrgit_repository_info")!;
  expect(metadata.inputSchema).toMatchObject({ type: "object", required: ["path"] });
  expect(metadata.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  expect(metadata.description).toBeTypeOf("string");
  expect(client.getInstructions()).toContain("running desktop");
  expect((await client.listResources()).resources.map(resource => resource.uri)).toContain("pwrgit://live-status/capabilities/v2");
  expect(consent).not.toHaveBeenCalled();
  expect(policy.snapshot().sessions[0]?.consent?.permissions).toEqual(BUILT_IN_MCP_ROLES.at(-1)!.permissions);
  expect(await client.callTool({ name: "pwrgit_repository_info", arguments: { path: tmpdir() } })).toMatchObject({ isError: true });
});

it("a relay is granted exactly its --role, or the most capable role, without a prompt; an unknown role gets nothing", async () => {
  const { endpoint, consent, policy } = await fixture();
  const custom = policy.createRole({ name: "Custom", description: "", permissions: ["repository.roots.read"], repositoryRoots: null });
  const cases: Array<[string[], string]> = [
    [[], "builtin.app-operator"],
    ...BUILT_IN_MCP_ROLES.map(role => [["--role", role.id], role.id] as [string[], string]),
    [[`--role=${custom.id}`], custom.id]
  ];
  for (const [args, roleId] of cases) {
    await host(endpoint, args);
    const session = policy.snapshot().sessions.at(-1)!;
    const role = policy.snapshot().roles.find(candidate => candidate.id === roleId)!;
    expect(session.roleId, args.join(" ")).toBe(roleId);
    expect(session.consent?.permissions, args.join(" ")).toEqual(role.permissions);
  }
  // Each relay is its own Session, named so Settings can tell them apart.
  const names = policy.snapshot().sessions.filter(s => s.revokedAt === null).map(s => s.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.slice(0, 2)).toEqual(["Fixture", "Fixture 2"]);
  const before = policy.snapshot().sessions.length;
  await expect(host(endpoint, ["--role", "builtin.root"])).rejects.toThrow(/builtin\.discovery.*builtin\.app-operator/);
  expect(policy.snapshot().sessions).toHaveLength(before);
  expect(consent).not.toHaveBeenCalled();
});

it("revocation and disconnect never transfer a Session into a replacement connection", async () => {
  const active = await fixture();
  const first = await host(active.endpoint);
  const id = active.policy.snapshot().sessions[0]!.id;
  active.policy.revokeSession(id);
  await expect(first.client.listTools()).rejects.toThrow();
  const second = await host(active.endpoint);
  const replacement = active.policy.snapshot().sessions[1]!;
  expect(replacement.id).not.toBe(id);
  await active.server.stop();
  await expect(second.client.listTools()).rejects.toThrow();
  // Stopping ends the Session; it is never resumed by a later connection.
  expect(active.policy.snapshot().sessions.find(s => s.id === replacement.id)?.revokedAt).not.toBeNull();
  await active.server.start();
  expect(active.policy.snapshot().sessions).toHaveLength(2); // no automatic reconnect
  await host(active.endpoint);
  expect(active.policy.snapshot().sessions).toHaveLength(3);
  expect(active.consent).not.toHaveBeenCalled();
});

it("direct HTTP requires a fresh native bootstrap and rejects retained standalone/OAuth tokens", async () => {
  const { server, endpoint, policy, consent } = await fixture();
  const legacy = policy.createSession("Legacy", "builtin.discovery");
  expect((await http(endpoint, legacy.token, initialize)).status).toBe(401);
  const credential = await server.bootstrapHttp(new AbortController().signal);
  const initialized = await http(endpoint, credential.token, initialize);
  expect(initialized.status).toBe(200);
  expect(initialized.body).toContain('"version":"99.2.3"');
  expect(initialized.session).toBeTruthy();
  expect(consent).toHaveBeenCalledTimes(1);
  // Closing the last IPC connection ends this Session, never a resumable grant.
  await vi.waitFor(() => expect(policy.snapshot().sessions.filter(s => s.consent && s.revokedAt === null)).toHaveLength(0));
  expect((await http(endpoint, credential.token, initialize)).status).toBe(401);
});
