# Cloudflare Artifacts

Git storage, not a change-request forge. Official Git/auth/REST docs and
integration scope: `docs/cloudflare-artifacts.md` at the repo root.

Only explicitly registered hosts resolve. Repo tokens are encrypted by
Electron safeStorage in a separate credential file; refuse Linux basic_text.
Never put a token in settings, argv, a remote, an event, or a log. Reads return
metadata only. Git receives URL-scoped headers through ephemeral environment
config, with redirects disabled. No live Cloudflare calls in tests.

Wrangler owns account authentication. Use the shared audited CLI runner in an
isolated temporary cwd, never a checkout's config/env files. Explicitly pin
both account-id environment aliases. `whoami --json` may contain credentials
on older versions: retain account metadata only, never log/reuse token fields.
Git issues a fresh one-hour read/write token per operation for a connected
account; do not persist it. Keep manual safeStorage tokens as the unconnected
fallback, but never hide a failed issuance behind that fallback.

CLI JSON evidence is pinned in `fixtures/wrangler.json` to Cloudflare's source
and captured upstream output assertions. Unknown shapes fail with actionable
errors. Creation is an explicit local-window action; no automatic retry or
provisioning during discovery. The namespace browser is separate from forge
search/fork capabilities, which remain unavailable.
