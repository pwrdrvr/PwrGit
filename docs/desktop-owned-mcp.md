# Desktop-owned MCP decision

PwrGit must already be running, independently launched by the operator. An MCP
caller must never launch it. Repository filesystem work, Git, forge CLI calls,
app catalog queries and MCP handlers run in that desktop process or its own
helpers. `pwrgit-mcp` only relays bytes over an authenticated loopback connection.

## Evaluation and scope

At `6f733c05`, `packages/mcp-server/src/bin.ts` starts the shared factory in a
caller-owned stdio process. The desktop HTTP listener uses that factory with an
app backend, but standalone omits app tools. The factory reports a hardcoded
`0.1.0`. PwrRoute's `crates/pwrroute-mcp/src/proxy.rs` demonstrates the smaller
alternative: byte relay to handlers owned by a running desktop, using per-user
Unix sockets or Windows named pipes.

This change adopts desktop ownership and opaque forwarding, using the existing
opt-in loopback listener with a versioned WebSocket upgrade at `/mcp/stdio`.
That reuses PwrGit's existing cross-platform listener, authenticated Sessions and
host/origin checks. It does not introduce a second OS-specific IPC authorization
scheme. Unix sockets and named pipes are deferred; same-user access would still
need application authorization. Loopback WebSocket is a local transport, not
remote hosting or an additional OAuth grant flow.

The relay has no MCP client or copied registry. Initialization, tools/list,
schemas, annotations, descriptions, instructions, resources, templates, prompts,
notifications, server requests, results and extension metadata come from the
connected desktop. Skills can be served as desktop resources/prompts when the
desktop supports them; this change does not invent a skill protocol or ship a
new skill catalog. The existing shared factory remains an internal library and
test seam, rather than a supported standalone executable.

## Platform permission rationale

On macOS, TCC identifies responsible code using heuristics. Keeping repository
work in an independently launched app avoids putting it in the caller-launched
relay's process tree. This is an architectural rationale, not proof that every
permission inherits or that the desktop always has access. App Sandbox
inheritance, TCC attribution, BSD permissions, ACLs and Endpoint Security are
distinct checks. Attribution can break, for example with daemonization; protected
locations and macOS releases differ. Apple's primary account is
[On File System Permissions](https://developer.apple.com/forums/thread/678819),
including its responsible-code discussion. Do not use undocumented attribution
APIs to escape caller restrictions. Test protected-folder behavior in clean VMs
with the signed desktop and each supported macOS release before making a claim
about a particular TCC service. This PR's automated tests establish ownership
and authorization behavior, not a measured TCC permission matrix.

Windows normally runs a child with its parent's primary access token, but access
also depends on the process token, object security descriptors and any
impersonation. That is not macOS TCC attribution; see Microsoft's
[Process Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights).
Linux fork/exec preserves many credentials, with documented exceptions for
set-ID executables/capabilities and constraints including `no_new_privs`; see
[fork(2)](https://man7.org/linux/man-pages/man2/fork.2.html) and
[execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html).
Neither platform implies universal permission inheritance. The desktop still
runs under its own OS restrictions, including any sandbox or mandatory policy.

## Compatibility and versions

| Layer | Contract |
| --- | --- |
| Relay release | Actual `@pwrgit/mcp-server` package version, in `--version` and stderr diagnostics |
| Desktop release | `app.getVersion()` in MCP serverInfo and authenticated upgrade response; also printed to relay stderr |
| Byte transport | Exact WebSocket subprotocol `pwrgit.mcp-relay.v1`; unknown protocols fail the upgrade |
| MCP protocol/capabilities | Negotiated end to end by the host and desktop SDK; the relay does not interpret them |

Release equality is neither required nor sufficient for compatibility. A newer
desktop can add tools/resources/prompts without a relay release. A desktop
without `/mcp/stdio`, a transport mismatch, invalid authorization or a stopped
app fails closed. There is no fallback to filesystem-only handlers, HTTP
translation, app launch, automatic reconnect or request retry. Transport errors
contain instructions to open PwrGit, enable local-agent access and reconnect in
the host. Diagnostic version headers do not authenticate the desktop's binary;
loopback uses the same local-machine trust model as the existing HTTP endpoint.

## Authorization and migration

- Updating the stdio executable changes its behavior immediately: it now requires
  the running desktop and enabled local-agent listener. Keep existing
  `PWRGIT_MCP_SESSION_TOKEN` values. Only the dedicated WebSocket upgrade accepts
  legacy non-OAuth Sessions; `/mcp` continues to require OAuth-issued Sessions.
- The relay does not load `PWRGIT_MCP_POLICY_FILE`, `PWRGIT_MCP_ROOTS`, caller
  working-directory discovery or caller Git configuration. A token from another
  policy/user-data directory is not a credential for this desktop. Update those
  configurations explicitly; new connections should use desktop HTTP OAuth.
- Every connection and incoming MCP message validates the Session against the
  desktop policy. Existing handlers independently recheck required capabilities,
  OAuth-consented scope ceilings and canonical repository boundaries before
  actions, resource reads/subscriptions and live polls. Knowing the loopback URL
  or sharing a user account grants no access. Roles and approval state are never
  copied into the relay. The upgrade itself never opens or approves consent.
- Existing HTTP clients keep the same URL, OAuth consent/PKCE, scopes, token
  binding and revocation behavior. HTTP remains stateless POST-only MCP;
  resources/subscriptions are unavailable there. Use on-demand reads or the
  existing authorized live-event fallback.
- Existing already-running standalone binaries cannot be converted remotely.
  Operators must replace their executable/configuration and manually reconnect
  when convenient. This update neither restarts active host sessions nor
  transfers/replays pending approvals. Revoking an old Session remains available
  if an old binary should lose access.
- Quitting the desktop or disabling local-agent access closes relay connections,
  destroys connection-owned watches, and retains the existing behavior of
  cancelling pending OAuth approvals and invalidating unused codes. Saved
  Session credentials remain revocable; a new connection starts with fresh MCP
  initialization and discovery. No call is replayed across the interruption.

## Discovery and host caches

The stdio relay forwards standard `notifications/tools/list_changed`,
`notifications/resources/list_changed`, `notifications/prompts/list_changed` and
resource update notifications. The desktop SDK advertises supported capabilities
and emits discovery notifications on registration changes. A supporting host
must re-run the corresponding list/read operation; a notification is not the new
content. See the MCP [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
and [prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
contracts used by the installed SDK.

Stateless HTTP has no standing notification stream. HTTP hosts must explicitly
re-discover tools/resources/prompts when needed. Hosts that ignore list-change
notifications need their own refresh/re-discovery action or a manual reconnect
at an operator-chosen point. Already-loaded skill text does not change merely
because a resource list changes: list and read the resource again, then update
host context explicitly. Initialization instructions, serverInfo and negotiated
capabilities are session metadata, without a general refresh notification in
this SDK protocol. A new initialization after a manual reconnect refreshes them;
never restart an active session merely to force new metadata into the host.
