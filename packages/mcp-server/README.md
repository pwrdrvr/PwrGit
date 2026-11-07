# @pwrgit/mcp-server

Desktop-owned MCP handlers for PwrGit. The independently launched Electron main
process provides the Git runner, app backend, policy authorizer and app version.

Configure clients with the bundled Rust `pwrgit-mcp` executable shown in
Settings → Local Agents. It relays stdio to the running desktop's protected Unix
socket or Windows named pipe. Compatible hosts can use HTTP directly over that
endpoint. Every connection requires native consent; there is no TCP listener,
app-launch fallback, standalone server fallback or request replay.

The old Node/npm executable is retired. It exits with migration instructions. It never imports server handlers, starts
the app or runs repository work.

See [desktop MCP documentation](../../docs/mcp-server.md).
