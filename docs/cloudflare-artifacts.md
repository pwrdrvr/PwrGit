# Cloudflare Artifacts

PwrGit supports Artifacts accounts through Wrangler and Git over HTTPS.
Artifacts stores Git history and refs. Cloudflare's [announcement](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
describes it as the foundation for Git platforms; it has no documented pull
request, issue, or review API.

## Connect with Wrangler

1. Use an existing Cloudflare account with Artifacts access (Workers Paid).
   Install the user-managed Wrangler CLI with `npm install -g wrangler` and
   run `wrangler login` in a terminal. Restart PwrGit after changing its PATH.
   PwrGit does not install Wrangler, create accounts, or upgrade plans.
2. Open **Settings → Forges → Cloudflare Artifacts → Re-check Wrangler**.
   PwrGit reads validated account metadata from `wrangler whoami --json`.
   Each account is explicitly registered; its Enabled checkbox controls access.
3. Open **Clone**, select Cloudflare Artifacts if another forge is selected,
   and click **Browse Cloudflare repositories**. Choose an account and namespace,
   then select a repository. The picker lists that namespace and filters locally;
   it does not pretend Wrangler offers global repository search.
4. Clone uses the exact remote returned by Wrangler. Fetch and pull issue a
   fresh read token; push issues a fresh write token. Tokens expire after one
   hour, stay in memory, and never replace the credential-free Git remote.
5. **Create repository** explicitly creates an empty repository in the selected
   account/namespace with `main` as the default branch. It does not create a
   namespace. Creation is never retried automatically; after an uncertain failure,
   browse the namespace before submitting again.

Wrangler owns OAuth/API credentials. PwrGit never reads its credential files or
reuses a token from `whoami` output. Commands run outside repositories so a
checkout's Wrangler configuration and local environment files cannot redirect
account selection. Each operation pins the selected account explicitly.
Cloudflare permission, access, and unsupported/old Wrangler errors stay visible.
Repository metadata can mark a repo read-only; otherwise push permission and
visibility remain unknown. Listing a repository does not prove push access.

## Connect with a manually issued repository token

1. Use an existing Cloudflare account with access to Artifacts. The
   [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) and
   [changelog](https://developers.cloudflare.com/artifacts/platform/changelog/)
   pages describe an open beta requiring Workers Paid as of October 10, 2026.
   PwrGit does not create accounts or upgrade plans. Repository creation requires an explicit action in Clone.
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
   each time when Wrangler is not connected to that account; the remote stored in `.git/config` remains credential-free.
5. When the token expires or is revoked, issue a replacement in Cloudflare and
   save it for the same remote. Forgetting a token removes the local credential;
   it does not revoke the token in Cloudflare or remove the registered host.

Manually supplied tokens are repository-scoped: save one for each remote you use. Connected Wrangler accounts obtain fresh tokens automatically; a failed issuance is reported rather than silently falling back to a saved token. PwrGit cannot
infer read/write scope from the token. A read token, a `read_only` repository,
or revoked access can cause push to fail; Git's server error remains visible.
Expiry and missing-credential errors point back to Settings. Visibility and push permissions remain unknown for a manually supplied remote. The Wrangler browser reports read-only repositories when its response provides that flag.

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

Saving a connection or discovering an account through Wrangler explicitly registers that account's host as Artifacts.
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
  PwrGit hides the PR/fork/SSH and CLI-clone choices for a registered Artifacts source.
  Commit-author account lookup remains inconclusive.
- Repository list/get/create and repo-token issuance use the documented Wrangler
  commands. Fork/import/delete, namespace provisioning, and token revocation are
  not exposed. Workers deployment and contest submissions are outside this integration.
  Wrangler performs list pagination; a response exceeding PwrGit's bounded CLI
  output limit fails explicitly instead of presenting a truncated catalog.
- Cloudflare's [limits](https://developers.cloudflare.com/artifacts/platform/limits/)
  include 1 GB per repo and 32 MB per blob. No rate-limit header dialect is
  assumed by PwrGit.

## Contract and validation

Implementation was checked against official docs retrieved October 10, 2026:
[Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
(page stamp April 25), [authentication](https://developers.cloudflare.com/artifacts/guides/authentication/),
[REST schemas](https://developers.cloudflare.com/artifacts/api/rest-api/)
(August 13), and [Wrangler commands](https://developers.cloudflare.com/artifacts/api/wrangler/).
Wrangler JSON shapes are additionally verified against Cloudflare workers-sdk
[`fcf625da014474f656a962b9313dec54563f3573`](https://github.com/cloudflare/workers-sdk/tree/fcf625da014474f656a962b9313dec54563f3573/packages/wrangler/src/artifacts)
and its `__tests__/artifacts.test.ts` and `__tests__/whoami.test.ts` output
assertions. The checked-in `fixtures/wrangler.json` adapts those upstream
assertions with contrived account IDs and tokens; it is not a live response
capture. Unknown JSON shapes are rejected. Docs stamps describe those pages,
not live API availability or a successful credential test.

Automated checks use contrived account IDs/tokens, encrypted-storage doubles,
real local Git config matching, and a local smart-HTTP Git fixture. The fixture
checks clone/fetch/pull/push headers and bare remotes; its read/write denial is
a mock permission check. No test calls live Artifacts APIs. Live Artifacts
clone/push, v2 push rejection, account access and token revocation were not
tested without credentials. The v1 push selection follows the published
contract.
