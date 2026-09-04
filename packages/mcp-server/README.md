# PwrGit MCP server

`@pwrgit/mcp-server` is PwrGit's read-only local MCP server. It lets an agent
find GitHub and GitLab checkouts, inspect safe repository/worktree metadata,
and subscribe to normalized local/PR/MR/CI status.

## Connect an agent

Open **PwrGit → Settings → Agents** and turn on **Local agent access**. Then,
from the agent you want to connect:

```bash
pwrgit-mcp pair --client "Claude Code" --format claude
```

PwrGit shows an approval card naming the client and the role it will get.
Approve it and the command prints a ready-to-run line:

```bash
claude mcp add-json pwrgit '{"command":"…","args":["…","serve"],"env":{…}}'
```

`--format mcp-json` (default) prints a config object to paste into any MCP
client, and `--format env` prints the two environment variables. Nothing is
granted until you approve it in the PwrGit window; an unanswered request
expires, and a token is handed out exactly once.

`pwrgit-mcp status` reports whether PwrGit is accepting connections, so a
client can tell "PwrGit is not running" apart from "the operator declined".

The installed app ships the server, so there is nothing to build. If you are
working from a checkout instead:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm install
pnpm --filter @pwrgit/mcp-server build
```

## Configure by hand

Settings → Agents can also mint a Session directly and copy a complete client
config. Built-in roles cover repository discovery, local metadata, and live
forge status; custom roles can choose individual permissions and restrict
every path-taking operation to specific existing repository roots.

The equivalent stdio configuration, with absolute paths:

```json
{
  "mcpServers": {
    "pwrgit": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/PwrGit/packages/mcp-server/dist/bin.js"
      ],
      "env": {
        "PWRGIT_MCP_POLICY_FILE": "/Users/me/Library/Application Support/PwrGit/mcp-policy.json",
        "PWRGIT_MCP_SESSION_TOKEN": "pgmcp_copy-the-one-time-token-here",
        "PWRGIT_MCP_ROOTS": "/Users/me/src:/Users/me/work"
      }
    }
  }
}
```

The policy-file variable is optional when the standard PwrGit app-data path is
used. The Session token is mandatory and is never logged or persisted in
plaintext; the policy stores only its SHA-256 hash. Revocation, role changes,
permissions, and repository boundaries are re-read before every tool call,
resource read/subscription, and WebSocket poll.

`PWRGIT_MCP_ROOTS` uses the platform path delimiter (`:` on macOS/Linux, `;`
on Windows). It is optional: PwrGit also considers the current repository's
parent and existing conventional folders such as `~/src`, `~/projects`, and
`~/work`. It never selects the home directory or a filesystem root
automatically. A caller can still opt into a broad scan by supplying that path
explicitly, subject to the same depth and directory budgets.
Configured and caller-provided roots never expand a restricted role's approved
repository boundary.

The stdio protocol owns stdout. Diagnostics go only to stderr.

## Tools

- `pwrgit_repository_roots` — bounded discovery of likely repository roots.
- `pwrgit_find_checkout` — locate a checkout by GitHub/GitLab identity.
- `pwrgit_repository_info` — canonical remote/provider, credential-free
  remotes, fork/upstream evidence, default/current branches, worktrees, and
  safe aggregate status. Returns the ten most relevant worktrees by default
  plus a `worktreeSummary` over all of them; raise `maxWorktrees` for more.
- `pwrgit_watch_repository` — create a versioned subscribable MCP status
  resource.
- `pwrgit_live_status_capabilities` — discover the standard subscription path
  and optional WebSocket fallback contract.

Arguments are `repository` for `pwrgit_find_checkout` and `path` for
`pwrgit_repository_info` / `pwrgit_watch_repository`. See
[the protocol and security documentation](../../docs/mcp-server.md) for the
full parameter table, resource schemas, event states, limits, and provider
requirements.
