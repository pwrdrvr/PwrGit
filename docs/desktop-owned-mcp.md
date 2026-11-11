# Desktop-owned MCP over local IPC

The independently launched PwrGit desktop owns the MCP implementation. A caller
never launches PwrGit. Open PwrGit, enable Settings → Local Agents → Enable
local-agent access, then configure the host using the displayed command or IPC
HTTP configuration. The native executable contains transport code only.

This replaces #527's loopback WebSocket design. The reference is
[PwrSnap #774](https://github.com/pwrdrvr/PwrSnap/pull/774), pinned at
`c4f179d3e6fec763eb6f018890696c45a0b9696f`; native link code retains its PwrDisk
MIT attribution. This work starts from origin/main, without cherry-picking
#527's independent npm server or WebSocket relay.

## Connections and ownership

| Connection | Framing | Consent and lifetime |
| --- | --- | --- |
| Host starts `pwrgit-mcp [--role ID]` | Versioned raw preamble, then newline-delimited MCP bytes | One Session per connection, granted the requested role without a prompt |
| Host connects to `unix:///…#/mcp` or `pipe:///pipe/…#/mcp` | Streamable HTTP over the same protected endpoint | Settings bootstrap, native consent, one credential bound to one live MCP Session |
| Desktop starts `pwrgit-mcp --desktop-listen --allow-http` | Bounded control frames on inherited stdio | Desktop owns helper lifetime; helper loss closes all Sessions |

Only the desktop starts the listener role. It owns initialization identity,
instructions, tools, schemas, descriptions, annotations, resources, prompts and
execution. A future desktop skill/resource/prompt registration uses that same
interface; this transport change does not invent a separate skill catalog.
The host relay copies bytes and never has a local tool registry or privileged
repository handlers. The native listener checks one initial line within three
seconds: a raw greeting shorter than 128 bytes or an HTTP/1.x request line at
most 4096 bytes. It preserves prefetched HTTP bytes and never switches framing
mid-connection. Electron's HTTP parser is fed an IPC Duplex and never listens
on a port. Live status uses MCP resources/subscriptions, including HTTP SSE;
the old per-server TCP WebSocket event fallback is removed.

MCP initialization reports the desktop app release (`app.getVersion()`). The
native relay reports its own release and the listener transport release;
`PWRGIT-MCP/1` identifies wire compatibility. Release equality is not required.
The raw preamble is `PWRGIT-MCP/1 <relay version> <identity>`, plus a fourth
`role=<id>` field only when the relay was started with `--role`. A relay that
names no role sends the three fields every desktop accepts; a desktop that
predates roles refuses four fields as an incompatible transport instead of
granting more than was asked.
MCP protocol/capability negotiation still happens end-to-end in the desktop.
A transport mismatch fails with update/manual-reconnect instructions.

## Authorization

Unix endpoints live in private owned directories. The socket and lock are
owner-only; both ends of the native connection check peer UID. A retained
ownership lock and inode checks protect stale cleanup. Windows uses a protected
current-user SID-only DACL, rejects remote clients, claims the first pipe
instance, verifies the connected server's owner in the native relay, and cancels
pending I/O on drop. These are OS connection checks, not MCP authorization.
Direct HTTP hosts supply their own IPC client; PwrGit does not claim that those
hosts implement the native relay's server-verification checks.

A relay Session is granted the role its `--role` names, or
`builtin.app-operator` when it names none, without a prompt; an unknown role
closes the connection with the valid ids in the initialize error. A direct HTTP
Session still requires approval in the specific native consent window. A host's
claimed name is only a display label, made unique among active Sessions. The desktop snapshots the approved role's
capabilities and repository roots into a persisted consent ceiling. Later role
edits or reassignment cannot exceed that ceiling. Authorization checks run on
every incoming MCP message and every tool/resource operation. Repository paths
remain canonicalized by the existing policy store. Existing OAuth scope ceilings
remain enforced on historical records, but legacy credentials cannot establish
new IPC Sessions.

Direct HTTP setup uses a random bearer credential, returned once to the UI and
held only as a hash by the HTTP adapter. It expires after two minutes if unused;
exactly one initialize consumes it. Subsequent requests require both that bearer
and its MCP Session id. Every HTTP method rechecks the current policy, including
SSE GET and DELETE, before it reaches protocol handling. One IPC connection cannot switch identities, including
across pipelined requests and asynchronous body reads. Credentials are excluded
from URLs, logs, policy projections and copyable configuration. The configuration
uses a fresh password-input reference for each bootstrap. GET SSE supports server
notifications and requests; DELETE or disconnect closes the Session. Event
history, Last-Event-ID resumption and operation replay are not supported.

Stdio and HTTP share a serialized 16-Session pool. Pending consent reserves a
slot. Admission reclaims revoked Sessions and awaits handler/watch cleanup before
reusing their slots. Stream overflow, failed output, native listener loss,
disablement and app shutdown tear down Sessions and revoke their native grants.

Each Session admits at most eight application request handlers at once, with a
FIFO backlog bounded to 128 requests and 4 MiB of request payloads. Excess work
receives an MCP error and can be retried after earlier requests finish. This
limit applies to the desktop factory over both stdio and IPC HTTP. Cancellation
notifications and replies to server requests bypass application admission.
Canceling queued work removes it; canceling active work retains its slot until
the handler settles, even when that handler ignores abort or the SDK suppresses
its response. Handler failures also release their slots.

## Migration

Existing TCP HTTP/OAuth clients must replace their URL with the native stdio
command or direct IPC HTTP configuration and approve a fresh native Session.
Browser OAuth routes and TCP listeners are retired; OAuth redirect behavior over
socket/pipe URLs is not assumed. Existing standalone npm clients must copy the
new native command from Settings. The old npm command fails with migration instructions; it never starts handlers
or another executable.
Historical Session/role records are retained without converting them into new
approvals. No credentials or pending approvals are transferred between Sessions.

There is no app-launch fallback, standalone fallback, automatic reconnect, active
agent-turn restart or approval replay. If the app is missing, disabled or stops,
open it yourself, enable local-agent access, then manually reconnect in the host.

Supported tools/resources/prompts list-change notifications pass through. Hosts
must re-list after invalidation and explicitly re-read changed resources. Loaded
skill text and initialization instructions do not update automatically: the host
must re-read or the user must choose to reconnect. Do not restart an active
Session just to refresh discovery metadata.

## Platform attribution and validation

Keeping Git/filesystem work in the independently launched desktop avoids placing
those operations in a caller-launched server process tree. This does not promise
universal macOS permission inheritance: Apple's responsible-code attribution,
code signing, service, resource and user consent can affect TCC decisions.
Primary references: [Apple's TCC attribution discussion](https://developer.apple.com/forums/thread/678819),
[Unix socket peer credentials](https://docs.rs/tokio/latest/tokio/net/struct.UnixStream.html#method.peer_cred),
[Windows named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights),
and [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
Signed-app TCC behavior needs clean-machine testing; unit tests do not establish it.

Generated tests cover arbitrary byte partitions, Unicode/extension metadata,
framing, backpressure and scheduled admission/revocation histories. Native tests
exercise real socket security, ownership, stale cleanup, incompatible greetings
and cancellation. Integration tests use the packaged relay protocol with the
real desktop factory, native consent seam, policy file and HTTP parser. Run
`pnpm test`, `pnpm lint`, `pnpm build`, and the three-platform native CI workflow.
Rust builds are pinned by Cargo.lock; their normal/build dependency graph is
verified against the license snapshot and disclosed in THIRD_PARTY_LICENSES.
