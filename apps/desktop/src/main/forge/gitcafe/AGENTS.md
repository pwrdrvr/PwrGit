# GitCafe

CLI-only integration. Require user-installed `cafe` >= 0.5.0 and Bun; 0.4.x
speaks the pre-migration API and may return success with incomplete data.
Never import or ship `@gitcafe/cli`, read its credential files, or export a token.
`CliForgeProvider` authenticates inside each command; `connectForge` adapts the
existing token-based GitHub/GitLab providers without changing their transports.

Use `runCafe` (the shared audited spawner), JSON schemaVersion 1, and explicit
`--host https://HOST/api` on every repository operation. No interactive flags,
browsers, update checks, or inherited TTY. On Windows invoke the installed
cafe.js through Bun, not a Node-generated npm shim. Test fixtures are contrived
copies of the 0.5.0 shapes; no live forge requests in CI.

PR list pagination must finish before negative caching. List rows without
cross-fork provenance need a detail read before matching a local branch; a
same-named branch in another fork must never authorize local branch pruning. Never infer commit
association from a matching branch/head: exact-commit lookup and account/avatar
proof are unsupported for now. Return unknown, not an authoritative null.
Repository suggestions use one page of at most 50 accessible repositories,
filtered on demand; users can paste an exact owner/name for repositories outside
that page. There is no verified CLI repository-search command. Fork creation
returns an admission; wait for the repository to become readable, propagate
cancellation, and never retry the creation itself automatically.

Contract evidence: https://www.npmjs.com/package/@gitcafe/cli (0.5.0), public
`cafe repo view` / `cafe pr list` / `cafe pr view` responses, and CLI help.
The 0.5.0 raw `cafe api` command failed during verification; keep this integration
on the verified subcommands until the CLI fixes that path.
