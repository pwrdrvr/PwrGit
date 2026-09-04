#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPwrGitMcpServer } from "./server.js";
import { CLI_USAGE, parseArgs, runPair, runStatus, type CliIo } from "./cli.js";

function stderr(message: string, cause?: unknown): void {
  const suffix =
    cause === undefined
      ? ""
      : ` ${JSON.stringify(
          cause instanceof Error ? { message: cause.message } : cause
        )}`;
  process.stderr.write(`[pwrgit-mcp] ${message}${suffix}\n`);
}

/** `serve` owns stdout for protocol frames, so every human-facing line goes to
 * stderr and only a command's machine-readable result reaches stdout. */
const io: CliIo = {
  info: (message) => process.stderr.write(`${message}\n`),
  out: (message) => process.stdout.write(`${message}\n`)
};

async function serve(): Promise<void> {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    if (args.error !== undefined) {
      io.info(`pwrgit-mcp: ${args.error}\n`);
      io.info(CLI_USAGE);
      process.exitCode = 2;
      return;
    }
    io.out(CLI_USAGE);
    return;
  }

  if (args.command === "status") {
    process.exitCode = await runStatus(args, io);
    return;
  }

  if (args.command === "pair") {
    process.exitCode = await runPair(args, io, {
      execPath: process.execPath,
      scriptPath: fileURLToPath(import.meta.url)
    });
    return;
  }

  await serve();
}

void main().catch((cause) => {
  stderr("fatal", cause);
  process.exitCode = 1;
});
