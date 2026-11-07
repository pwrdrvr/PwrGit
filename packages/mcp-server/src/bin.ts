#!/usr/bin/env node
// Retired entry point: never imports handlers, runs Git or starts an application.
process.stderr.write("Configure your host with the native relay command from PwrGit Settings → Local Agents. Open PwrGit yourself and enable local-agent access, then reconnect manually. This retired npm entry never launches the app or an independent MCP server.\n");
process.exitCode = 1;
