# PwrGit MCP

PwrGit's running desktop owns MCP. Enable **Settings → Local Agents → Enable
local-agent access**, then copy the native relay command for your host. A host
never launches the app. Each live connection opens PwrGit's native approval
window, where you choose a Session Name and role.

The transport is a protected Unix-domain socket on macOS/Linux or Windows named
pipe. There are no MCP TCP ports. Capable HTTP hosts can connect directly using
the Settings-provided `unix:///…#/mcp` or `pipe:///pipe/…#/mcp` URL. Approve a direct
HTTP Session in Settings first; supply its short-lived bootstrap credential
separately when the host prompts. Browser OAuth is not used over IPC.

The desktop exposes app-backed tools for profiles, repositories, recent visits,
worktrees, refresh and navigation, plus bounded repository discovery, checkout
location, metadata and read-only live forge status. Tools retain their schemas,
annotations and structured/text output. Read-only roles do not gain app navigation
or Git mutation permissions from the transport.

Live updates use standard MCP resources: call `pwrgit_watch_repository`, read its
returned URI, subscribe with `resources/subscribe`, and re-read after
`notifications/resources/updated`. HTTP clients receive notifications over SSE.
Hosts without subscriptions can explicitly re-read. Discover the current
contract with `pwrgit_live_status_capabilities`; v2 removes the old WebSocket
fallback. Discovery is desktop-owned; re-list after list-change notifications.
Loaded instructions and skill text require explicit re-reading or manual reconnect.

Updating old configurations requires migration: retire TCP URLs, OAuth login
recipes and independently running npm servers. Copy the current native executable
command or IPC HTTP configuration from Settings and approve a fresh Session.
Historical roles and Session records remain visible without carrying approval
into the replacement connection. If PwrGit closes, enable it again and manually
reconnect in the host. Requests, events and approvals are never replayed.

[Architecture, migration, security and platform qualifications](desktop-owned-mcp.md)
include the PwrSnap reference and testing requirements.
