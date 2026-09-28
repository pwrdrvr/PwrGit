# V8 on Chromium Googlesource

V8's repository is hosted at
<https://chromium.googlesource.com/v8/v8.git>; its GitHub repository is an
**official mirror**. The Googlesource repository is not merely a public replica
of a GitHub contribution workflow. [V8 source documentation](https://v8.dev/docs/source-code)

## Hosting and contributions

Googlesource hosts Git repositories; [Gitiles](https://gerrit.googlesource.com/gitiles/+/HEAD/README.md)
is the repository browser. Chromium's review service is
[Gerrit](https://chromium-review.googlesource.com/). These are separate surfaces.

External contributors can submit changes. V8 requires review and a contributor
license agreement, and directs contributors to Chromium's review workflow.
Contributors use a Google/Gerrit account and matching Git email, upload a change
with depot_tools (`git cl upload`), request review, address feedback with new
patch sets, and land approved changes through the commit queue. New contributors
may need a reviewer to run try jobs. This is not a personal fork followed by a
GitHub-style pull request, and account creation does not confer direct landing
permissions. See [V8 contributing](https://v8.dev/docs/contribute) and
[Chromium contributing](https://chromium.googlesource.com/chromium/src/+/main/docs/contributing.md).

Gerrit's underlying review uploads target `refs/for/<branch>`. It matches
subsequent patch sets using Change-Id, repository and branch; patch-set refs and
review labels require their own model. See [Gerrit upload documentation](https://gerrit-review.googlesource.com/Documentation/user-upload.html)
and [Change-Ids](https://gerrit-review.googlesource.com/Documentation/user-changeid.html).

## PwrGit support

PwrGit identifies **Gerrit** as the review product. Google is the operator of
Googlesource, not the name of the integration. Gerrit also runs outside Google;
[Qt's contribution workflow](https://wiki.qt.io/Gerrit_Introduction) uses
`codereview.qt-project.org`.

Desktop support includes:

- Clone a supplied URL, or a simple pasted `git clone URL` command, preserving
  its transport, username, port and project path. PwrGit does not invent an SSH
  alternative for the V8 HTTPS URL. Shell flags and compound commands are not
  executed. A single-component project works on an identified Gerrit host.
- Recognize the documented Chromium and Qt deployments. Other installations
  require an explicit Gerrit host in Settings → Forges (or
  `PWRGIT_GERRIT_HOSTS`). Unknown hosts remain unknown.
- Configure a separate HTTPS **Review URL** for the Git host, including a
  deployment path if needed. Chromium maps to
  `https://chromium-review.googlesource.com`; an SSH port is not reused as a
  review API port.
- Read public repository identity and changes anonymously: open lists, lookup
  by number and commit, draft/open/merged/abandoned status, and available size
  and timestamps. Abandoned changes use the app's closed state. Reads do not
  establish account access or push permission.
- Fetch a validated current patch-set ref into `change/<number>/<patch-set>`
  without force or an upstream. Each patch set has a separate local branch.
  Gerrit's target branch is never treated as the contribution's source branch.
- Show the Gerrit mark and open the appropriate browser: Chromium's Gitiles
  repository page, or the Gerrit project's changes page elsewhere. Change
  links use the review endpoint.

The public adapter validates Gerrit's JSON prefix, bounds responses and
requests, walks pagination up to the existing 500-change cap, and preserves
cached data when a read fails. It does not send credentials or follow redirects.
Host switches gate public reads, as they do other forge operations.

Not implemented: Gerrit authentication, private REST reads, account/owner
listing, fork creation, repository search, change upload, review votes,
checks/submit-readiness, submission or Chromium's commit queue. Git operations
still use Git's own configured authentication. The standalone MCP server
recognizes Gerrit remotes but does not provide Gerrit live review queries.

A plain clone is useful for browsing history but is not a build-ready V8
workspace. Follow [V8's checkout instructions](https://v8.dev/docs/source-code)
to obtain dependencies and setup.

## Validation

Small synthetic REST fixtures cover Chromium, Qt and a separately configured
review host, including pagination failures and patch-set validation. A real Git
and SQLite fixture checks successive patch-set fetches and profile isolation.
Public REST reads against Chromium and Qt confirmed their response and ref
shapes; no full V8 checkout was needed.

The adapter follows Gerrit's [REST conventions](https://gerrit-review.googlesource.com/Documentation/rest-api.html),
[change queries and RevisionInfo](https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html),
and [project identity](https://gerrit-review.googlesource.com/Documentation/rest-api-projects.html).
