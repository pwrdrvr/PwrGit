import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { createPwrGitMcpServer, type AppBackend } from "@pwrgit/mcp-server";
import { McpPolicyStore, PolicyFileAuthorizer } from "@pwrgit/mcp-server/access-policy";
import { relayStdio } from "@pwrgit/mcp-server/stdio-relay";
import { MCP_RELAY_PATH, MCP_RELAY_PROTOCOL } from "@pwrgit/mcp-server/agent-access-protocol";
import { AgentAccessServer } from "./agent-access-server";
import { DesktopMcpRelay } from "./desktop-mcp-relay";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-desktop-relay-"));
  const inside = join(dir, "inside"), outside = join(dir, "outside");
  mkdirSync(inside); mkdirSync(outside);
  const policy = new McpPolicyStore(join(dir, "policy.json")); policy.initialize();
  const role = policy.createRole({ name: "Bounded", description: "", permissions: ["repository.roots.read", "repository.metadata.read", "app.navigate"], repositoryRoots: [inside] });
  const credential = policy.createSession("Legacy stdio", role.id);
  const backend: AppBackend = {
    catalog: () => ({ activeProfileId: "one", profiles: [{ id: "one", name: "One", roots: [inside] }, { id: "two", name: "Two", roots: [outside] }],
      repositories: [{ id: "inside", profileId: "one", name: "Inside", path: inside, pinned: false, worktrees: [] },
        { id: "outside", profileId: "two", name: "Outside", path: outside, pinned: false, worktrees: [] }] }),
    open: vi.fn(), refresh: vi.fn()
  };
  const runner = vi.fn().mockRejectedValue(new Error("Unexpected Git execution"));
  const options = { desktopVersion: "9.8.7", policyFile: policy.filePath, clientsFile: join(dir, "clients.json"),
    port: 0, appBackend: backend, runner, onChanged: () => undefined,
    requestConsent: vi.fn(async () => ({ decision: "deny" as const, sessionName: "", roleId: "" })) };
  const server = new AgentAccessServer(options); await server.start();
  cleanups.push(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { server, policy, credential, backend, runner, options, inside, outside, role };
}

async function relayed(port: number, token: string) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  let diagnosticText = ""; diagnostics.on("data", chunk => { diagnosticText += chunk.toString(); });
  const transport = new StdioServerTransport(output, input);
  const client = new Client({ name: "relay-test-host", version: "2" });
  const completion = relayStdio({ port, token, input, output, diagnostics }).catch(async error => {
    await transport.close(); return error as Error;
  });
  cleanups.push(async () => { input.end(); await completion; await client.close(); });
  await client.connect(transport);
  return { client, completion, diagnostics: () => diagnosticText };
}

async function trackedRelay(policy: McpPolicyStore, beforeClose: () => Promise<void> = async () => undefined) {
  const http = createServer(); http.listen(0, "127.0.0.1"); await once(http, "listening");
  const port = (http.address() as { port: number }).port;
  const created: Array<Awaited<ReturnType<typeof createPwrGitMcpServer>>> = [];
  const closeStarted = vi.fn();
  const closeFinished = vi.fn();
  const relay = new DesktopMcpRelay({ http, policyFile: policy.filePath, desktopVersion: "9.8.7",
    authority: () => `127.0.0.1:${port}`, allowedOrigin: origin => origin === undefined,
    createServer: async token => {
      const server = await createPwrGitMcpServer({ serverVersion: "9.8.7", authorizer: new PolicyFileAuthorizer(policy.filePath, token) });
      const close = server.close;
      server.close = async () => { closeStarted(); await beforeClose(); await close(); closeFinished(); };
      vi.spyOn(server.statusResources, "close");
      vi.spyOn(server.eventServer, "close");
      created.push(server);
      return server;
    } });
  cleanups.push(async () => { await relay.close(); await new Promise<void>(resolve => http.close(() => resolve())); });
  return { port, created, closeStarted, closeFinished };
}

function attemptSocket(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${MCP_RELAY_PATH}`, MCP_RELAY_PROTOCOL, {
    headers: { authorization: `Bearer ${token}` }
  });
  socket.on("error", () => undefined);
  cleanups.push(async () => { socket.terminate(); });
  const status = new Promise<number>(resolve => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
  });
  return { socket, status };
}

it("tears down the desktop server and frees its slot when stdio input overflows across permitted frames", async () => {
  const { policy, credential } = await fixture();
  const { port, created, closeFinished } = await trackedRelay(policy);
  const connections = Array.from({ length: 16 }, () => attemptSocket(port, credential.token));
  expect(await Promise.all(connections.map(connection => connection.status))).toEqual(Array(16).fill(101));
  await vi.waitFor(() => expect(created).toHaveLength(16));
  const socket = connections[0]!.socket;
  const initialized = once(socket, "message");
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "overflow-host", version: "1" }
  } }) + "\n");
  await initialized;
  // Each WebSocket message is below the frame limit; the unfinished stdio
  // message exceeds the read buffer only after the second message arrives.
  socket.send("x".repeat(48 * 1024));
  socket.send("x".repeat(48 * 1024));
  await vi.waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(closeFinished).toHaveBeenCalledTimes(1);
  });
  const retired = created.filter(server => vi.mocked(server.statusResources.close).mock.calls.length === 1);
  expect(retired).toHaveLength(1);
  expect(retired[0]!.eventServer.close).toHaveBeenCalledTimes(1);
  expect(await attemptSocket(port, credential.token).status).toBe(101);
});

it("reclaims all idle revoked connections before admitting concurrent replacements without exceeding the cap", async () => {
  const { policy, credential } = await fixture();
  let release!: () => void;
  const drain = new Promise<void>(resolve => { release = resolve; });
  const { port, created, closeStarted, closeFinished } = await trackedRelay(policy, () => drain);
  try {
    const connections = Array.from({ length: 16 }, () => attemptSocket(port, credential.token));
    expect(await Promise.all(connections.map(connection => connection.status))).toEqual(Array(16).fill(101));
    await vi.waitFor(() => expect(created).toHaveLength(16));
    const replacement = policy.createSession("Replacement", "builtin.discovery");
    expect(await attemptSocket(port, replacement.token).status).toBe(429);
    policy.revokeSession(credential.session.id);
    const replacements = [attemptSocket(port, replacement.token), attemptSocket(port, replacement.token)];
    const admitted: number[] = [];
    const admissions = Promise.all(replacements.map(async connection => { const status = await connection.status; admitted.push(status); return status; }));
    await vi.waitFor(() => expect(closeStarted).toHaveBeenCalledTimes(16));
    expect(closeFinished).not.toHaveBeenCalled();
    expect(admitted).toEqual([]);
    expect(created).toHaveLength(16);
    release();
    expect(await admissions).toEqual([101, 101]);
    await vi.waitFor(() => expect(created).toHaveLength(18));
    expect(closeFinished).toHaveBeenCalledTimes(16);
    expect(connections.every(connection => connection.socket.readyState === WebSocket.CLOSED)).toBe(true);
    // Both admitted connections consume slots; only fourteen more fit.
    const more = Array.from({ length: 15 }, () => attemptSocket(port, replacement.token));
    const statuses = await Promise.all(more.map(connection => connection.status));
    expect(statuses.filter(status => status === 101)).toHaveLength(14);
    expect(statuses.filter(status => status === 429)).toHaveLength(1);
  } finally { release(); }
});

it("uses desktop discovery, schemas, annotations, instructions and version with a differently versioned relay", async () => {
  const { server, policy, credential, options } = await fixture();
  const { client, diagnostics } = await relayed(server.port, credential.token);
  expect(client.getServerVersion()).toEqual({ name: "PwrGit", version: "9.8.7" });
  expect(diagnostics()).toMatch(/relay \d+\.\d+\.\d+; desktop 9\.8\.7/);
  expect(client.getInstructions()).toContain("stdio relay");
  expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
  const tools = await client.listTools();
  expect(tools.tools.some(tool => tool.name === "pwrgit_app_repositories")).toBe(true);
  const oauth = policy.createSession("HTTP fixture", "builtin.local-reader", { clientId: "fixture", scopes: ["repository.metadata.read"] });
  const http = new Client({ name: "http-host", version: "1" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${oauth.token}` } } });
    await http.connect(transport as unknown as Parameters<typeof http.connect>[0]);
    const httpTools = await http.listTools();
    // The desktop describes the watch operation for each transport's actual
    // subscription capability. All other metadata must be identical.
    const normalize = (result: typeof tools) => result.tools.map(tool => tool.name === "pwrgit_watch_repository"
      ? { ...tool, description: "transport-specific watch instructions" } : tool);
    expect(normalize(httpTools)).toEqual(normalize(tools));
    expect(http.getServerVersion()).toEqual(client.getServerVersion());
    expect(http.getServerCapabilities()?.resources?.subscribe).not.toBe(true);
    const catalog = await client.callTool({ name: "pwrgit_app_repositories", arguments: {} });
    expect(catalog.structuredContent).toMatchObject({ repositories: [{ id: "inside" }] });
    expect(options.requestConsent).not.toHaveBeenCalled();
  } finally { await http.close(); }
});

it("enforces per-call validation, two-profile repository boundaries, role edits, OAuth scopes and revocation", async () => {
  const { server, policy, credential, backend, runner, outside, role } = await fixture();
  const { client, completion } = await relayed(server.port, credential.token);
  expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: "outside" } })).isError).toBe(true);
  expect((await client.callTool({ name: "pwrgit_repository_info", arguments: { path: outside } })).isError).toBe(true);
  expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: 17 } })).isError).toBe(true);
  expect(backend.open).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
  expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: "inside" } })).isError).not.toBe(true);
  expect(backend.open).toHaveBeenCalledTimes(1);
  policy.updateRole(role.id, { permissions: ["repository.metadata.read"] });
  expect((await client.callTool({ name: "pwrgit_app_open", arguments: { repoId: "inside" } })).isError).toBe(true);
  const scoped = policy.createSession("Consented reader", "builtin.app-operator", { clientId: "fixture", scopes: ["repository.metadata.read"] });
  const second = await relayed(server.port, scoped.token);
  expect((await second.client.callTool({ name: "pwrgit_app_open", arguments: { repoId: "inside" } })).isError).toBe(true);
  expect(backend.open).toHaveBeenCalledTimes(1);
  policy.revokeSession(credential.session.id);
  await expect(client.listTools()).rejects.toThrow();
  expect(await completion).toBeInstanceOf(Error);
});

it("fails closed on desktop disconnect and reconnects only through a new host connection", async () => {
  const { server, credential } = await fixture();
  const first = await relayed(server.port, credential.token);
  await server.stop();
  expect((await first.completion as Error).message).toContain("reconnect the MCP server");
  await expect(first.client.listTools()).rejects.toThrow();
  const output = new PassThrough(); let bytes = 0; output.on("data", chunk => { bytes += chunk.length; });
  await expect(relayStdio({ port: server.port, token: credential.token, input: new PassThrough(), output })).rejects.toThrow("Open PwrGit yourself");
  expect(bytes).toBe(0);
  await server.start();
  const next = await relayed(server.port, credential.token);
  expect((await next.client.listTools()).tools.length).toBeGreaterThan(5);
});

it("rejects unauthenticated, revoked, wrong-origin, wrong-host and incompatible transport upgrades", async () => {
  const { server, policy, credential } = await fixture();
  const status = (headers: Record<string, string>, protocol = MCP_RELAY_PROTOCOL) => new Promise<number>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${MCP_RELAY_PATH}`, protocol, { headers });
    ws.on("error", () => undefined);
    ws.on("unexpected-response", (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
  });
  expect(await status({})).toBe(401);
  expect(await status({ authorization: "Bearer invalid" })).toBe(401);
  expect(await status({ authorization: `Bearer ${credential.token}`, origin: "https://attacker.example" })).toBe(403);
  expect(await status({ authorization: `Bearer ${credential.token}`, host: "attacker.example" })).toBe(403);
  expect(await status({ authorization: `Bearer ${credential.token}` }, "pwrgit.mcp-relay.v99")).toBe(426);
  policy.revokeSession(credential.session.id);
  expect(await status({ authorization: `Bearer ${credential.token}` })).toBe(401);
});

it("negotiates an older MCP host protocol independently of relay and desktop releases", async () => {
  const { server, credential } = await fixture();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${MCP_RELAY_PATH}`, MCP_RELAY_PROTOCOL, {
    headers: { authorization: `Bearer ${credential.token}`, "x-pwrgit-relay-version": "0.0.1" }
  });
  socket.on("error", () => undefined);
  cleanups.push(async () => { socket.terminate(); });
  await once(socket, "open");
  const response = once(socket, "message");
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", clientInfo: { name: "old-host", version: "0.1" }, capabilities: {}
  } }) + "\n");
  const [bytes] = await response;
  expect(JSON.parse(bytes.toString())).toMatchObject({ result: { protocolVersion: "2024-11-05", serverInfo: { version: "9.8.7" } } });
});

it("fails against an older HTTP-only desktop without consuming or executing pending MCP input", async () => {
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  cleanups.push(() => new Promise<void>(resolve => http.close(() => resolve())));
  const input = new PassThrough(), output = new PassThrough();
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
  await expect(relayStdio({ port: (http.address() as { port: number }).port, token: "legacy", input, output }))
    .rejects.toThrow("Older desktops need an update");
  expect(input.readableLength).toBeGreaterThan(0);
  expect(output.readableLength).toBe(0);
});

it("preserves desktop-added discovery metadata and notifications for tools, resources, skills and prompts", async () => {
  const { policy, credential } = await fixture();
  const http = createServer(); http.listen(0, "127.0.0.1"); await once(http, "listening");
  const port = (http.address() as { port: number }).port;
  let desktop: Awaited<ReturnType<typeof createPwrGitMcpServer>> | undefined;
  const relay = new DesktopMcpRelay({ http, policyFile: policy.filePath, desktopVersion: "10.0.0", authority: () => `127.0.0.1:${port}`,
    allowedOrigin: origin => origin === undefined,
    createServer: async token => {
      desktop = await createPwrGitMcpServer({ serverVersion: "10.0.0", authorizer: new PolicyFileAuthorizer(policy.filePath, token) });
      desktop.mcp.registerPrompt("desktop-guide", { description: "Desktop prompt" },
        () => ({ messages: [{ role: "user", content: { type: "text", text: "re-discover" } }] }));
      return desktop;
    } });
  cleanups.push(async () => { await relay.close(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const { client } = await relayed(port, credential.token);
  let toolsChanged = 0, resourcesChanged = 0, promptsChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { toolsChanged++; });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { resourcesChanged++; });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => { promptsChanged++; });
  desktop!.mcp.registerTool("desktop_added", { description: "Added by the desktop", inputSchema: {},
    annotations: { readOnlyHint: true }, _meta: { revision: 2 } },
    () => ({ content: [{ type: "text", text: "payload" }], structuredContent: { text: "payload" }, _meta: { preserved: true } }));
  desktop!.mcp.registerResource("desktop-skill", "pwrgit://skills/example", { mimeType: "text/markdown", description: "Skill text from desktop" },
    uri => ({ contents: [{ uri: uri.href, text: "Desktop-owned skill revision 2" }] }));
  desktop!.mcp.registerPrompt("new-guide", { description: "New desktop guide" }, () => ({ messages: [] }));
  await vi.waitFor(() => { expect(toolsChanged).toBe(1); expect(resourcesChanged).toBe(1); expect(promptsChanged).toBe(1); });
  expect((await client.listTools()).tools.find(tool => tool.name === "desktop_added")).toMatchObject({
    description: "Added by the desktop", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { revision: 2 } });
  expect(await client.callTool({ name: "desktop_added", arguments: { text: "payload" } })).toMatchObject({ structuredContent: { text: "payload" }, _meta: { preserved: true } });
  expect((await client.listResources()).resources.some(resource => resource.uri === "pwrgit://skills/example")).toBe(true);
  expect(await client.readResource({ uri: "pwrgit://skills/example" })).toMatchObject({ contents: [{ text: "Desktop-owned skill revision 2" }] });
  expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(["desktop-guide", "new-guide"]);
  expect(await client.getPrompt({ name: "desktop-guide", arguments: { topic: "re-discover" } })).toMatchObject({ messages: [{ content: { text: "re-discover" } }] });
});

it("relays unknown bidirectional messages and metadata byte-for-byte without interpreting MCP", async () => {
  const websocket = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(websocket, "listening");
  cleanups.push(() => new Promise<void>(resolve => websocket.close(() => resolve())));
  const port = (websocket.address() as { port: number }).port;
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const up = '{"jsonrpc":"2.0","id":"custom","method":"future/request","params":{"_meta":{"approval":"never-replay"}}}\n';
  const down = '{"jsonrpc":"2.0","method":"notifications/future","params":{"_meta":{"custom":true}}}\n';
  const received: Buffer[] = [], returned: Buffer[] = [];
  output.on("data", chunk => returned.push(chunk));
  websocket.once("connection", socket => {
    socket.on("message", data => {
      received.push(Buffer.from(data as Buffer));
      if (Buffer.concat(received).toString().endsWith("\n")) socket.send(down);
    });
  });
  const completion = relayStdio({ port, token: "fixture", input, output, diagnostics });
  input.write(up.slice(0, 7)); input.write(up.slice(7));
  await vi.waitFor(() => expect(Buffer.concat(returned).toString()).toBe(down));
  expect(Buffer.concat(received).toString()).toBe(up);
  input.end(); await completion;
});
