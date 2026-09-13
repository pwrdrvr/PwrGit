# @pwrgit/mcp-server

PwrGit app profiles, indexed repositories, recent navigation, open/refresh actions,
and read-only Git metadata and live status. App-backed tools require the desktop
HTTP server; standalone stdio remains filesystem-based.

The desktop app exposes OAuth-protected MCP at
`http://127.0.0.1:51731/mcp`. Enable local-agent access in Settings → Agents,
connect a standard MCP OAuth client, and approve it in PwrGit’s native window.
See [the connection guide](../../docs/mcp-server.md#connect-an-agent).

The package also retains its original standalone stdio entry point for existing
clients. It requires `PWRGIT_MCP_SESSION_TOKEN` and reads the desktop policy
file (or `PWRGIT_MCP_POLICY_FILE`). Workspace installation builds the standalone
server automatically. Start it with:

```sh
pnpm --filter @pwrgit/mcp-server start
```

After changing its source, rebuild with `pnpm --filter @pwrgit/mcp-server build`.

The desktop HTTP interface uses OAuth rather than a pairing CLI or copied
tokens. Revocation and repository boundaries apply to both transports.
