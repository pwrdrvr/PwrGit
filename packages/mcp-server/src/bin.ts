#!/usr/bin/env node

import { relayStdio } from "./stdio-relay.js";
import { MCP_PACKAGE_VERSION } from "./version.js";

if (process.argv.includes("--version")) {
  process.stdout.write(`pwrgit-mcp relay ${MCP_PACKAGE_VERSION}\n`);
} else {
  void relayStdio().catch((cause: unknown) => {
    process.stderr.write(`[pwrgit-mcp] ${cause instanceof Error ? cause.message : "Relay failed"}\n`);
    process.exitCode = 1;
  });
}
