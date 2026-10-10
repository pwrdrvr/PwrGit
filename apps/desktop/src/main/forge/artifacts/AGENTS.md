# Cloudflare Artifacts

Git storage, not a change-request forge. Official Git/auth/REST docs and
integration scope: `docs/cloudflare-artifacts.md` at the repo root.

Only explicitly registered hosts resolve. Repo tokens are encrypted by
Electron safeStorage in a separate credential file; refuse Linux basic_text.
Never put a token in settings, argv, a remote, an event, or a log. Reads return
metadata only. Git receives URL-scoped headers through ephemeral environment
config, with redirects disabled. No live Cloudflare calls in tests.
