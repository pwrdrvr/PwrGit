#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPwrGitMcpServer } from "./server.js";

function stderr(message: string, cause?: unknown): void {
  const suffix =
    cause === undefined
      ? ""
      : ` ${JSON.stringify(
          cause instanceof Error ? { message: cause.message } : cause
        )}`;
  process.stderr.write(`[pwrgit-mcp] ${message}${suffix}\n`);
}

async function main(): Promise<void> {
  const server = await createPwrGitMcpServer();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  server.mcp.server.onclose = () => void shutdown();
  server.mcp.server.onerror = (cause) => stderr("protocol error", cause);
  await server.mcp.connect(new StdioServerTransport());
  stderr("ready", {
    transport: "stdio",
    liveStatus: "mcp_resource_subscription",
    websocketFallback: true
  });
}

void main().catch((cause) => {
  stderr("fatal", cause);
  process.exitCode = 1;
});
