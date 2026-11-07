import fc from "fast-check";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import { FixedMcpAuthorizer, fullAccessAuthorization } from "./access-policy.js";
import { createPwrGitMcpServer } from "./server.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

async function pipeline(count: number): Promise<void> {
  let release = (): void => undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let peak = 0;
  let started = 0;
  const server = await createPwrGitMcpServer({
    authorizer: new FixedMcpAuthorizer(fullAccessAuthorization())
  });
  server.mcp.registerTool("blocked", {}, async () => {
    active++;
    started++;
    peak = Math.max(peak, active);
    try { await blocked; return { content: [] }; }
    finally { active--; }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pipeline", version: "1" });
  await server.mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const requests = Array.from({ length: count }, () =>
    client.callTool({ name: "blocked" }).catch(error => error as unknown));
  try {
    await flush();
    expect(active).toBe(Math.min(count, 8));
    expect(peak).toBeLessThanOrEqual(8);
    release();
    const results = await Promise.all(requests);
    expect(results.every(result => !(result instanceof Error))).toBe(true);
    expect(started).toBe(count);
    expect(peak).toBeLessThanOrEqual(8);
  } finally {
    release();
    await Promise.all(requests);
    await client.close();
    await server.close();
  }
}

test("pipelined MCP requests never start more than eight application handlers per session", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 64 }), pipeline));
});

test("nine pipelined calls leave the ninth queued until a handler finishes", async () => {
  await pipeline(9);
});
