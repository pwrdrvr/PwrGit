# Cloudflare Artifacts

PwrGit supports existing Artifacts repositories through Git over HTTPS.
Artifacts stores Git history and refs. Cloudflare's [announcement](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
describes it as the foundation for Git platforms; it has no documented pull
request, issue, or review API.

## Connect an existing repository

1. Use an existing Cloudflare account with access to Artifacts. The
   [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) and
   [changelog](https://developers.cloudflare.com/artifacts/platform/changelog/)
   pages describe an open beta requiring Workers Paid as of October 10, 2026.
   PwrGit does not create accounts, upgrade plans, or provision repositories.
2. Copy the exact `remote` returned by the Artifacts REST API or Workers binding:
   `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`.
   Obtain a repo token using the [authentication guide](https://developers.cloudflare.com/artifacts/guides/authentication/).
   `read` permits clone/fetch/pull; `write` also permits push. A Cloudflare API
   token authenticates the control plane and cannot authenticate Git.
3. Open **Settings → Forges → Cloudflare Artifacts**. Paste the credential-free
   remote and the **full** `art_v1_<40 hex>?expires=<unix_seconds>` repo token.
   Save it. “Tokens saved” confirms local storage, without claiming a live
   Cloudflare login or validating the token's scope/revocation.
4. Paste the same remote into **Clone** and use HTTPS. Existing checkouts can
   use it as their remote. Clone, fetch, pull and push receive the saved token
   each time; the remote stored in `.git/config` remains credential-free.
5. When the token expires or is revoked, issue a replacement in Cloudflare and
   save it for the same remote. Forgetting a token removes the local credential;
   it does not revoke the token in Cloudflare or remove the registered host.

Tokens are repository-scoped: save one for each remote you use. PwrGit cannot
infer read/write scope from the token. A read token, a `read_only` repository,
or revoked access can cause push to fail; Git's server error remains visible.
Expiry and missing-credential errors point back to Settings. Visibility and
push permissions remain unknown because this integration does not fetch
repository metadata.

## Credential handling

Electron `safeStorage` encrypts a separate `artifacts-credentials.enc` file in
PwrGit's user-data directory using the OS credential store. Tokens are not
written to settings, remotes, command arguments, events, or read responses.
Unavailable encryption and Linux's insecure `basic_text` fallback are refused.
Unlock/configure the OS keyring and reopen Settings if secure storage is
unavailable. Credentials are app-wide, like existing forge logins; they are
scoped to the exact repository URL rather than a profile or whole account.

Git receives the full token via an ephemeral, repository-URL-scoped
`http.extraHeader` environment configuration. Redirects are disabled for that
repository. Diagnostic tracing is disabled during authenticated operations.
Tokens never enter a persistent Git config. External terminal commands and
the standalone MCP server do not receive these credentials.

Saving a connection explicitly registers that account's host as Artifacts.
There is no shared SaaS hostname and no suffix-based provider discovery.
Standalone MCP remote identity can opt in with
`PWRGIT_ARTIFACTS_HOSTS=<account-id>.artifacts.cloudflare.net`; it can then
identify local repositories using the full remote or `default/demo` with
provider `artifacts`. This does not add live forge API features or Git auth.

## Supported capabilities and limits

- Clone/fetch/pull use normal Git smart HTTP, with protocol v1 or v2. Push
  explicitly selects v1 as documented. Full and shallow clones are supported;
  partial clone (`--filter`) is rejected.
- Local history, diffs, commits, branches and worktrees use PwrGit's normal Git
  behavior. The forge badge opens the Cloudflare dashboard, without constructing
  an undocumented repository web page.
- No SSH, Git LFS, anonymous access, PRs, issues or review API are documented.
  PwrGit hides the PR/fork/SSH/CLI choices for a registered Artifacts source.
  Commit-author account lookup remains inconclusive.
- Cloudflare documents repository management, listing, forking, public HTTPS
  import and token issuance in its REST API. This slice does not implement
  those control-plane operations, repository search, or automatic token minting.
  Wrangler's documented `--json` flag has no published response schema; PwrGit
  does not guess it, read Wrangler's config, or extract its OAuth/API token.
  Workers deployment and contest submissions are outside this integration.
- Cloudflare's [limits](https://developers.cloudflare.com/artifacts/platform/limits/)
  include 1 GB per repo and 32 MB per blob. No rate-limit header dialect is
  assumed by PwrGit.

## Contract and validation

Implementation was checked against official docs retrieved October 10, 2026:
[Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
(page stamp April 25), [authentication](https://developers.cloudflare.com/artifacts/guides/authentication/),
[REST schemas](https://developers.cloudflare.com/artifacts/api/rest-api/)
(August 13), and [Wrangler commands](https://developers.cloudflare.com/artifacts/api/wrangler/).
Docs stamps describe those pages, not live API availability or a successful
credential test.

Automated checks use contrived account IDs/tokens, encrypted-storage doubles,
real local Git config matching, and a local smart-HTTP Git fixture. The fixture
checks clone/fetch/pull/push headers and bare remotes; its read/write denial is
a mock permission check. No test calls live Artifacts APIs. Live Artifacts
clone/push, v2 push rejection, account access and token revocation were not
tested without credentials. The v1 push selection follows the published
contract.
