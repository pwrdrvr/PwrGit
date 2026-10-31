# @pwrgit/mcp-server

PwrGit app profiles, indexed repositories, recent navigation, open/refresh actions,
and read-only Git metadata and live status. The running desktop owns every MCP
handler. It runs the Git selected in Settings, bundled Git by default.

Open PwrGit yourself and enable Settings → Local Agents → Enable local-agent
access before connecting. The caller never launches the app.

New clients should use the OAuth-protected endpoint at
`http://127.0.0.1:51731/mcp` and approve access in PwrGit’s native window.
See [connection instructions](../../docs/mcp-server.md#connect-an-agent).

Existing stdio configurations can keep `PWRGIT_MCP_SESSION_TOKEN` and the same
command after updating this package. `pwrgit-mcp` now relays opaque bytes to the
running desktop over authenticated loopback WebSocket. It does not read a policy
file, run Git, or provide an independent server. A stopped, disabled, outdated or
disconnected desktop fails with manual reconnect instructions; it never falls
back, reconnects automatically, or replays requests. HTTP continues to require
OAuth-issued Sessions. Existing roles, repository boundaries and OAuth scopes
apply to the relay too.

```sh
pnpm --filter @pwrgit/mcp-server start
```

Workspace installation builds the relay. After changing source, rebuild with
`pnpm --filter @pwrgit/mcp-server build`. `pwrgit-mcp --version` reports the relay
package release. MCP initialization reports the connected desktop release.
Release equality is not required: the relay transport protocol and MCP protocol
are negotiated independently. See the [migration and compatibility decision](../../docs/desktop-owned-mcp.md).
