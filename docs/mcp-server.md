# PwrGit MCP server and live-status protocol

The first PwrGit MCP server is a standalone, read-only stdio process under
`packages/mcp-server`. It follows the Pwr family conventions established by
PwrSnap: the official TypeScript SDK, explicit capabilities, structured tool
results, read-only tool annotations, typed resources, stderr-only diagnostics,
bounded inputs, and contract-level integration tests.

It does not require the Electron app to be running. That makes repository
discovery useful to local agents today, while leaving room for a later in-app
transport to use PwrGit's persisted profile index and consent UI.

## Transport decision

The MCP server uses stdio because it has the broadest local-client support and
does not create a separately discoverable HTTP control plane. MCP defines
standard resource subscriptions, so normalized live status uses those first:

1. Call `pwrgit_watch_repository` with an absolute worktree path.
2. Read the returned `pwrgit://status/v1/{watchId}` resource.
3. Send `resources/subscribe` for that URI.
4. When PwrGit sends `notifications/resources/updated`, re-read the URI.
5. Send `resources/unsubscribe` when the status is no longer needed.

The server advertises `resources: { subscribe: true, listChanged: true }`
during MCP initialization. This is the interoperable path defined by the
[MCP resource specification](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).

Some hosts negotiate subscriptions but do not surface resource updates as a
durable wakeup to an agent. For them, capability discovery also advertises an
optional loopback WebSocket. WebSocket is not the MCP transport; it carries
the same normalized status as an interoperability fallback.

## Repository discovery and metadata

`pwrgit_repository_roots` inspects, in priority order:

- roots explicitly supplied by the caller;
- roots in `PWRGIT_MCP_ROOTS`;
- the current repository's parent;
- existing conventional folders under the home directory.

Each scan has a maximum depth of five, a per-root directory budget, a 20,000
directory total budget, 32 roots, and explicit skip folders (`node_modules`,
`.git`, build output, caches, `Library`, and similar). Directory symlinks are
not followed. Checkout matching inspects at most 500 discovered repositories.
Results say when a budget truncated the scan.

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
- up to 64 worktrees with paths, heads, branches, detached/locked/prunable
  flags, and safe status summaries;
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
it is never logged and expires with the MCP process.

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
`providerAvailable: false` while local status remains usable.

GitHub live status reads the most recent PR for the checked-out branch,
including check rollup and latest review decision. GitLab reads the most recent
MR, its approval summary, blocking-discussion state, and current pipeline jobs.
GitLab does not expose a GitHub-style change-requested review aggregate, so the
v1 contract reports the explicit blockers GitLab does expose rather than
guessing.

This first server does not read PwrGit's Electron SQLite profile index. Set
`PWRGIT_MCP_ROOTS` for deterministic broad discovery. A future in-app server
can replace conventional-root inference with the persisted profile/clone
destination index without changing the versioned tool and resource contracts.
