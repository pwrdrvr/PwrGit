# PwrGit MCP server and live-status protocol

PwrGit exposes app state and explicit workspace navigation through MCP, plus
read-only Git discovery and live status. The server lives under `packages/mcp-server`, available
as a standalone stdio process or through the desktop app’s opt-in HTTP listener. It follows the Pwr family conventions established by
PwrSnap: the official TypeScript SDK, explicit capabilities, structured tool
results, accurate tool annotations, typed resources, stderr-only diagnostics,
bounded inputs, fail-closed RBAC, named revocable Sessions, and contract-level
integration tests.

The Electron app does not need to remain running for stdio clients; HTTP
clients require the app and its local-agent listener to remain running. Settings → Agents owns the
authorization graph and writes the cross-platform `mcp-policy.json` consumed
by standalone processes.

## Running-app tools (`pwrgit.app/v1`)

Use the desktop HTTP connection for app state. Standalone stdio tools cannot
see PwrGit's profiles or navigation history and do not advertise these tools.

| Tool | Purpose |
| --- | --- |
| `pwrgit_app_profiles` | Profile names, configured roots, active profile and authorized repository counts; no account email or credentials |
| `pwrgit_app_repositories` | Search indexed repositories by name, path or branch, across profiles or within `profileId`; return worktrees, paths, pins, saved selection and cached status |
| `pwrgit_app_recent_repositories` | Only repositories with recorded visits, newest first; explicit ordering and history coverage |
| `pwrgit_app_open` | Open/focus the repository's profile window and optionally reveal a particular worktree |
| `pwrgit_app_refresh` | Reconcile externally added/removed worktrees and refresh cached state using the same app services as the UI |

For “where are my most recently used repositories?”, call
`pwrgit_app_recent_repositories` with `{"limit":10}`. Results explicitly declare
`ordering.by=lastViewedAt`, descending direction, and exclude unvisited repos.
Results include `profileName` beside each repository and `profileCoverage` with
per-profile matching, visited, and returned counts. Ordering is global before the
limit is applied; the active profile receives no preference. A single-profile
page can still be correct if its visits are newest or other profiles lack history.
The `history` object reports authorized matching repositories with and without
visit records, so partial history cannot be mistaken for complete usage history.
Discovery-root responses link to this tool rather than implying that root order
is recent-use order.
`lastViewedAt` records actual selection in PwrGit, aggregated from worktrees;
`lastCommitAt` is a separate Git timestamp. Missing history stays `null` and
sorts last. The response includes `total` and `truncated`; the limit is 1–100.
Each repository also includes `worktreeCount` (primary plus linked),
`linkedWorktreeCount`, `pinnedWorktreeCount`, and `pinnedWorktreeBranchCount`
(distinct branch names among pinned worktrees, excluding detached, bare, and
unknown branch labels). The app has no separate
branch-favorite flag; repository `pinned` remains independent of worktree pins.
Each worktree exposes `pinned`, `isPrimary`, and `missing`. Counts include
registered missing checkouts, match the authorized returned worktree list, and
never include worktrees hidden by the Session's repository boundary.

The index can be stale until refreshed; cached dirty/ahead/behind counts are
not a fresh Git or network request.

Navigation history is persisted in PwrGit's SQLite state, per profile. Existing
sidebar localStorage history imports when a profile window selects a worktree.
A saved selection describes that profile's last selected worktree; it does not
prove the window is currently open. Opening a window through MCP updates history
through the same renderer selection path as a click.

Choose **Local Repository Reader** or **Live Forge Status** for the app read and
refresh tools. **PwrGit Workspace Control** additionally grants `app.navigate`.
Existing Sessions do not gain navigation implicitly: OAuth scopes and role
permissions must both grant it. Reauthorize if the original OAuth scope excluded
`app.navigate`. Repository boundaries filter catalog entries and worktrees and
are rechecked before an action. No arbitrary command dispatch, commit, push,
file editing or destructive Git operation is exposed by these app tools.

Desktop root discovery now uses profile roots and indexed repositories rather
than the Electron process's working directory. Standalone discovery retains its
bounded configured/conventional-folder behavior.

## Authorization policy v1

Every standalone MCP process must receive a named Session token through
`PWRGIT_MCP_SESSION_TOKEN`. HTTP clients send their Session token as a Bearer
credential on every request. Stdio is a one-client process transport, so the
Session environment is its client principal; HTTP OAuth would add a second
identity ceremony without improving isolation for that transport. The token is
256 random bits, is returned to the OAuth client at token exchange, and is stored only as a SHA-256 hash in a
user-private policy file. `PWRGIT_MCP_POLICY_FILE` overrides the standard
PwrGit app-data path when needed.

Settings → Agents visualizes **Session → role → effective permissions and
repository boundary**. It can revoke Sessions, assign roles, and
create, edit, or delete custom roles. Built-in roles are immutable and checked
against their canonical definitions on every policy read.

The versioned capabilities are:

| Capability | Governs |
| --- | --- |
| `repository.roots.read` | Bounded root discovery |
| `repository.checkout.locate` | Checkout lookup by forge identity |
| `repository.metadata.read` | App profiles, indexed repositories, navigation history, worktrees, safe local status, and index refresh |
| `forge.status.read` | PR/MR, CI, conflict, and review reads through `gh`/`glab` |
| `app.navigate` | Open/focus authorized repositories and worktrees in PwrGit |
| `status.subscribe` | MCP resource subscriptions and WebSocket fallback subscriptions |

A role's `repositoryRoots: null` allows the server's bounded discovery rules.
A non-empty root list narrows all path-taking tools and both notification paths
to those canonical directories. Symlinks are resolved before the boundary
check. A restricted discovery call uses only the assigned roots—it cannot fall
back to `PWRGIT_MCP_ROOTS`, the current workspace, or conventional home
folders.

Authorization is deliberately re-read before every tool call, resource read,
resource subscription, WebSocket subscription, and live poll. Revocation and
role edits therefore apply to already-running processes without restarting
them. Invalid JSON, missing canonical built-ins, role drift, unknown Sessions,
and missing permissions all fail closed. Tool annotations remain descriptive
MCP metadata; they are not used as authorization.

## Connect an agent

Enable **Settings → Agents → Enable local-agent access**. PwrGit serves
MCP at `http://127.0.0.1:51731/mcp` while enabled and running. The preference
persists across app restarts; it defaults to off.

**Claude Code**

```bash
claude mcp add --scope user --transport http pwrgit http://127.0.0.1:51731/mcp
claude mcp login pwrgit
```

**Codex CLI**

```bash
codex mcp add pwrgit --url http://127.0.0.1:51731/mcp --oauth-client-registration dcr
```

The client opens PwrGit’s native approval window. Choose a Session Name and
role, then Approve or Deny. Only that window’s main frame can submit the
decision. The browser page has no form or script and cannot approve access.
Settings lists the resulting Session and supports role changes and revocation.

This uses the same connection shape as PwrSnap: public OAuth clients, dynamic
registration, authorization-code flow with PKCE S256 and a resource indicator,
native approval, and non-expiring revocable access tokens. Product name,
port, tools, and role permissions are PwrGit-specific.

| Route | Behavior |
| --- | --- |
| `/.well-known/oauth-authorization-server` | Authorization server metadata |
| `/.well-known/oauth-protected-resource/mcp` | MCP resource metadata |
| `POST /register` | Dynamic registration; registration alone grants nothing |
| `GET /authorize` | Validate the request and open native approval |
| `GET /authorize/status` | Browser waiting page or PKCE-bound redirect |
| `POST /token` | Exchange a single-use authorization code |
| `POST /revoke` | Revoke the calling client’s token |
| `POST /mcp` | Stateless Streamable HTTP, authenticated on every request |

An unauthenticated MCP POST returns `401` with a `WWW-Authenticate` challenge
pointing to resource metadata. Every other MCP method returns `405` and
`Allow: POST`; HTTP does not create transport sessions or standalone SSE
streams. Authorization codes and pending approvals expire after five minutes.
Disabling the listener cancels pending approvals and invalidates unused codes.

Client registrations survive app restarts in the private
`mcp-oauth-clients.json`; Session tokens are stored only as hashes in
`mcp-policy.json`. Tokens are bound to their OAuth client and consented scopes.
Later role edits cannot enlarge an OAuth Session beyond those scopes.
HTTP accepts only OAuth-issued Sessions. There are no custom pairing endpoints
or manual credential-creation controls.

Existing standalone stdio clients remain compatible with their saved Session
tokens. Revoking those Sessions disables them too; turning off the HTTP listener
does not stop an independently launched stdio process.

## Transport decision

The standalone MCP server uses stdio; the optional desktop listener uses
Streamable HTTP. MCP defines
standard resource subscriptions on stdio, so those clients use:

1. Call `pwrgit_watch_repository` with an absolute worktree path.
2. Read the returned `pwrgit://status/v1/{watchId}` resource.
3. Send `resources/subscribe` for that URI.
4. When PwrGit sends `notifications/resources/updated`, re-read the URI.
5. Send `resources/unsubscribe` when the status is no longer needed.

The stdio server advertises `resources: { subscribe: true, listChanged: true }`.
Stateless HTTP advertises no resource subscriptions: read status resources on
demand, or use the WebSocket for live updates. Watch resources and WebSocket
capabilities remain isolated per authorized Session across HTTP requests and
are cleared when the listener stops. This is the interoperable path defined by the
[MCP resource specification](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).

Some hosts negotiate subscriptions but do not surface resource updates as a
durable wakeup to an agent. For them, capability discovery also advertises an
optional loopback WebSocket. WebSocket is not the MCP transport; it carries
the same normalized status as an interoperability fallback.

Capability discovery includes the current Session, role, effective
permissions, and repository roots under `authorization`. Reading the capability
resource or tool requires both `forge.status.read` and `status.subscribe` so an
under-scoped client cannot obtain the fallback capability URL.

## Repository discovery and metadata

Every tool parameter, so a client does not have to guess a name:

| Tool | Required | Optional |
| --- | --- | --- |
| `pwrgit_repository_roots` | — | `roots` (string[]), `includeConventional` (boolean, default true), `maxDepth` (0-5, default 4) |
| `pwrgit_find_checkout` | `repository` (string) | `provider` (`github`\|`gitlab`), `roots` (string[]), `maxDepth` (0-5), `maxResults` (1-20) |
| `pwrgit_repository_info` | `path` (string) | `maxWorktrees` (1-64, default 10) |
| `pwrgit_watch_repository` | `path` (string) | `intervalMs` (5000-300000, default 15000) |
| `pwrgit_live_status_capabilities` | — | — |

The repository argument is named `repository`, not `identity`, and the path
arguments are named `path`, not `repositoryPath`.

Every tool returns its full result in `structuredContent` **and** as a
serialized JSON text block, so a host that renders only `content` still shows
the caller the data.


`pwrgit_repository_roots` inspects, in priority order:

- roots explicitly supplied by the caller;
- roots in `PWRGIT_MCP_ROOTS`;
- the current repository's parent, unless that is the home directory or a
  filesystem root;
- existing conventional folders under the home directory.

Each scan uses a depth of four by default and five at most, a per-root
directory budget, a 20,000 directory total budget, 32 roots, and explicit skip
folders (`node_modules`,
`.git`, build output, caches, `Library`, and similar). Directory symlinks are
not followed. Checkout matching inspects at most 500 discovered repositories.
Results say when a budget truncated the scan.

The home directory and filesystem roots are never inferred automatically. A
caller may explicitly request one, in which case the same depth and directory
budgets still apply.

`pwrgit_find_checkout` accepts `owner/name`, `host/owner/name`, or a Git remote
URL. GitLab subgroup paths are retained. GitHub paths remain exactly two
segments, matching PwrGit's existing forge identity rules. Remote URLs are
parsed inside the process and discarded; only this shape is returned:

When the tool receives `roots`, it searches only those roots. Without `roots`,
it uses the configured, workspace, and conventional candidates above.

```json
{
  "provider": "github",
  "host": "github.com",
  "path": "pwrdrvr/PwrGit"
}
```

`pwrgit_repository_info` returns:

- canonical remote identity (`origin` when present) and provider;
- credential-free remote identities and their roles;
- an explicit fork relationship only when a distinct `upstream` remote proves
  it, otherwise `isFork: null`;
- resolved default and current branches;
- `worktrees`: the ten most relevant worktrees by default, ordered primary,
  conflicted, mid-operation, prunable, dirty, diverged, locked, quiet. Raise
  `maxWorktrees` up to 64 for more. A repository with dozens of worktrees
  otherwise costs an agent more tokens to read than the answer is worth;
- `worktreeSummary`: clean/dirty/conflicted/detached/locked/prunable/operation
  and ahead/behind counts across every inspected worktree, so a bounded list
  still says whether anything needs attention;
- `worktreeCount`, `worktreesReturned`, and `worktreesTruncated`;
- staged, unstaged, untracked, conflicted, ahead, and behind counts;
- an in-progress merge, rebase, cherry-pick, or revert indicator.

Status never contains changed filenames, diff contents, commit messages,
authors, emails, environment values, or raw remote URLs.

## Subscribable status resource v1

Resource URI template: `pwrgit://status/v1/{watchId}`

Media type: `application/json`

```json
{
  "protocol": "pwrgit.status-resource/v1",
  "version": "1.0",
  "resourceUri": "pwrgit://status/v1/opaque-id",
  "intervalMs": 15000,
  "snapshot": {
    "observedAt": "2026-08-23T12:00:00.000Z",
    "repositoryPath": "/Users/me/src/project",
    "identity": {
      "provider": "github",
      "host": "github.com",
      "path": "org/project"
    },
    "local": {
      "branch": "feature/live",
      "upstream": "origin/feature/live",
      "ahead": 1,
      "behind": 0,
      "stagedFiles": 0,
      "unstagedFiles": 0,
      "untrackedFiles": 0,
      "conflictedFiles": 0,
      "changedFiles": 0,
      "clean": true,
      "operation": null
    },
    "changeRequest": {
      "provider": "github",
      "host": "github.com",
      "repository": "org/project",
      "number": 42,
      "url": "https://github.com/org/project/pull/42",
      "state": "open",
      "draft": false,
      "sourceBranch": "feature/live",
      "targetBranch": "main"
    },
    "ci": {
      "state": "failure_with_running",
      "total": 4,
      "succeeded": 2,
      "failed": 1,
      "running": 1,
      "pending": 0,
      "skipped": 0
    },
    "mergeConflict": false,
    "reviews": {
      "decision": "changes_requested",
      "blocking": true,
      "blockingReason": "changes_requested",
      "latest": []
    },
    "providerAvailable": true
  }
}
```

CI states are versioned vocabulary:

- `success` — all completed checks passed or were skipped;
- `failure_with_running` — at least one failed while another is active;
- `terminal_failure` — at least one failed and none remain active;
- `running`, `pending`, `none`, or `unknown`.

Review blockers normalize GitHub change requests and the facts GitLab exposes:
`changes_requested`, `approval_required`, or `blocking_discussion`. PR/MR
lifecycle is `open`, `merged`, or `closed`.

The server polls only while a resource is subscribed. Cadence is bounded from
5 seconds to 5 minutes (15 seconds by default), with at most 64 resources per
server process. A changed normalized snapshot triggers one standard resource
update notification; the client then reads the full latest snapshot.

## Optional WebSocket fallback v1

Read `pwrgit://live-status/capabilities/v1` or call
`pwrgit_live_status_capabilities`. Both return a process-lifetime URL like:

```text
ws://127.0.0.1:<random-port>/events/v1/<256-bit-capability>
```

The listener binds only to `127.0.0.1`, requires the exact `Host`, rejects
non-loopback peers and non-loopback browser origins, requires subprotocol
`pwrgit.events.v1`, caps messages at 64 KiB, and allows 16 connections with 10
repository paths each. The unguessable URL path is an ephemeral capability;
it is never logged and expires with the MCP process. This transport capability
is layered under RBAC: every subscription and poll also revalidates the MCP
Session, required permissions, and repository roots.

Client subscribe message:

```json
{
  "type": "subscribe",
  "protocol": "pwrgit.events/v1",
  "subscriptionId": "agent-watch-1",
  "repositories": ["/Users/me/src/project"],
  "intervalMs": 15000
}
```

Server messages are `hello`, `subscribed`, `event`, `error`, and `pong`.
Client messages are `subscribe`, `unsubscribe`, and `ping`. Event kinds are:

- `snapshot`
- `repository.status`
- `ci.status`
- `merge.conflict`
- `review.submitted`
- `review.blocking`
- `change_request.state`

Every event carries `protocol: "pwrgit.events/v1"`, an id, monotonic process
sequence, timestamp, subscription id, repository path, kind, and the complete
current normalized snapshot. Change events also carry the previous snapshot;
review events may carry the new normalized review.

## Provider support and limits

Local Git metadata needs only `git`. Live GitHub status delegates credentials
to the installed `gh` CLI; GitLab delegates to `glab`. PwrGit never extracts or
returns their tokens. A signed-out, missing, or failed CLI yields
`providerAvailable: false` while local status remains usable. The same applies
to an incomplete follow-up query. Provider results are accepted only when the
change request's source repository and head SHA match the checkout. A distinct
same-host `upstream` remote is searched before `origin`, covering the usual
fork workflow without accepting another fork's same-named branch.

GitHub live status reads the most recent PR for the checked-out branch,
including check rollup and latest review decision. GitLab reads a matching MR's
detail, approval summary, blocking-discussion state, and pipeline jobs. Jobs
are fetched in bounded pages up to 500 entries; a follow-up failure or a larger
pipeline reports unknown CI and provider availability instead of silently
omitting jobs. Allowed-to-fail failed/manual jobs normalize as skipped.
GitLab does not expose a GitHub-style change-requested review aggregate, so the
v1 contract reports the explicit blockers GitLab does expose rather than
guessing.

The server does not read PwrGit's Electron SQLite profile index. Set
`PWRGIT_MCP_ROOTS` for deterministic broad discovery when the assigned role
allows all bounded repositories, or configure concrete repository roots on a
custom role. A future index-backed discovery implementation can replace
conventional-root inference without changing the versioned tool, resource, or
authorization contracts.
