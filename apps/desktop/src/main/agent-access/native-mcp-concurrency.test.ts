import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createPwrGitMcpServer } from "@pwrgit/mcp-server";
import { FixedMcpAuthorizer, fullAccessAuthorization, McpAccessError } from "@pwrgit/mcp-server/access-policy";
vi.mock("electron", () => ({ app: {} }));
import { McpByteTransport } from "./native-mcp-bridge";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const receive = (transport: McpByteTransport, message: JSONRPCMessage): void =>
  transport.receive(Buffer.from(JSON.stringify(message) + "\n"));
const initialize = { jsonrpc: "2.0", id: "init", method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pipeline", version: "1" }
} } as const;

test("256 pipelined repository-info calls start only eight runners while server-request replies still pass", async () => {
  let release = (): void => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const runner = vi.fn(async () => {
    await hold;
    return { exitCode: 1, stdout: "", stderr: "not a repository" };
  });
  const server = await createPwrGitMcpServer({
    runner, authorizer: new FixedMcpAuthorizer(fullAccessAuthorization())
  });
  const written: JSONRPCMessage[] = [];
  const transport = new McpByteTransport(bytes => { written.push(JSON.parse(bytes.toString()) as JSONRPCMessage); }, () => undefined);
  await server.mcp.connect(transport);
  try {
    receive(transport, initialize);
    await flush();
    for (let id = 0; id < 256; id++) receive(transport, {
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "pwrgit_repository_info", arguments: { path: tmpdir() } }
    });
    // Repository path authorization uses realpath; only the command runner is held.
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(8));
    const ping = server.mcp.server.ping();
    await flush();
    const request = written.find(message => "method" in message && message.method === "ping");
    expect(request).toBeDefined();
    if (request && "id" in request && request.id !== undefined)
      receive(transport, { jsonrpc: "2.0", id: request.id, result: {} });
    await ping;
    expect(runner).toHaveBeenCalledTimes(8);
    release();
    await vi.waitFor(() => expect(written.filter(message => !("method" in message) && message.id !== "init")).toHaveLength(256));
    expect(runner).toHaveBeenCalledTimes(136); // 8 active + 128 queued; 120 overload replies.
    expect(written.filter(message => "error" in message && message.error.code === -32000)).toHaveLength(120);
  } finally { release(); await server.close(); }
});

test("stdio cancellation bypasses queued work but an ignored abort cannot release an active slot", async () => {
  let release = (): void => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const server = await createPwrGitMcpServer({ authorizer: new FixedMcpAuthorizer(fullAccessAuthorization()) });
  const signals = new Map<number | string, AbortSignal>();
  server.mcp.registerTool("held", {}, async extra => {
    signals.set(extra.requestId, extra.signal);
    await hold;
    return { content: [] };
  });
  const transport = new McpByteTransport(() => undefined, () => undefined);
  await server.mcp.connect(transport);
  try {
    receive(transport, initialize);
    await flush();
    for (let id = 1; id <= 10; id++) receive(transport, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "held" } });
    await flush();
    expect(signals.size).toBe(8);
    for (const requestId of [1, 9]) receive(transport, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });
    await flush();
    expect(signals.get(1)?.aborted).toBe(true);
    expect(signals.size).toBe(8);
    release();
    await flush();
    expect(signals.has(9)).toBe(false);
    expect(signals.has(10)).toBe(true);
  } finally { release(); await server.close(); }
});

test("closing stdio aborts queued requests without starting them after active work finishes", async () => {
  let release = (): void => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const server = await createPwrGitMcpServer({ authorizer: new FixedMcpAuthorizer(fullAccessAuthorization()) });
  const work = vi.fn(async () => { await hold; return { content: [] }; });
  server.mcp.registerTool("held", {}, work);
  const transport = new McpByteTransport(() => undefined, () => undefined);
  await server.mcp.connect(transport);
  try {
    receive(transport, initialize);
    await flush();
    for (let id = 1; id <= 16; id++) receive(transport, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "held" } });
    await flush();
    expect(work).toHaveBeenCalledTimes(8);
    await transport.close();
    release();
    await flush();
    expect(work).toHaveBeenCalledTimes(8);
  } finally { release(); await server.close(); }
});

test("repository requests queued before revocation still recheck policy when admitted", async () => {
  let release = (): void => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let approved = true;
  const runner = vi.fn(async () => {
    await hold;
    return { exitCode: 1, stdout: "", stderr: "not a repository" };
  });
  const server = await createPwrGitMcpServer({ runner, authorizer: { authorize: async () => {
    if (!approved) throw new McpAccessError("revoked_session", "revoked");
    return fullAccessAuthorization();
  } } });
  const written: JSONRPCMessage[] = [];
  const transport = new McpByteTransport(bytes => { written.push(JSON.parse(bytes.toString()) as JSONRPCMessage); }, () => undefined);
  await server.mcp.connect(transport);
  try {
    receive(transport, initialize);
    await flush();
    for (let id = 1; id <= 16; id++) receive(transport, {
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "pwrgit_repository_info", arguments: { path: tmpdir() } }
    });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(8));
    approved = false;
    release();
    await vi.waitFor(() => expect(written.filter(message => !("method" in message) && message.id !== "init")).toHaveLength(16));
    expect(runner).toHaveBeenCalledTimes(8);
  } finally { release(); await server.close(); }
});
