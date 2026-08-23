# PwrGit MCP server

`@pwrgit/mcp-server` is PwrGit's read-only local MCP server. It lets an agent
find GitHub and GitLab checkouts, inspect safe repository/worktree metadata,
and subscribe to normalized local/PR/MR/CI status.

## Build and configure

From the PwrGit repository root:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm install
pnpm --filter @pwrgit/mcp-server build
```

Configure a stdio MCP client with absolute paths:

```json
{
  "mcpServers": {
    "pwrgit": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/PwrGit/packages/mcp-server/dist/bin.js"
      ],
      "env": {
        "PWRGIT_MCP_ROOTS": "/Users/me/src:/Users/me/work"
      }
    }
  }
}
```

`PWRGIT_MCP_ROOTS` uses the platform path delimiter (`:` on macOS/Linux, `;`
on Windows). It is optional: PwrGit also considers the current repository's
parent and existing conventional folders such as `~/src`, `~/projects`, and
`~/work`. It never scans the home directory itself.

The stdio protocol owns stdout. Diagnostics go only to stderr.

## Tools

- `pwrgit_repository_roots` — bounded discovery of likely repository roots.
- `pwrgit_find_checkout` — locate a checkout by GitHub/GitLab identity.
- `pwrgit_repository_info` — canonical remote/provider, credential-free
  remotes, fork/upstream evidence, default/current branches, worktrees, and
  safe aggregate status.
- `pwrgit_watch_repository` — create a versioned subscribable MCP status
  resource.
- `pwrgit_live_status_capabilities` — discover the standard subscription path
  and optional WebSocket fallback contract.

See [the protocol and security documentation](../../docs/mcp-server.md) for
resource schemas, event states, limits, and provider requirements.
