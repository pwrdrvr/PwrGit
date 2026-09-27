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

Paste **just the URL** into Clone and select **HTTPS**. PwrGit parses the host as
`other`, with project path `v8/v8`; the existing plain Git HTTPS clone path
constructs the documented URL without a forge login. It does not verify public
visibility through an API. No full V8 clone was used to validate this change:
small URL fixtures cover the coordinates and browser behavior.

The sidebar can open the repository page for `chromium.googlesource.com`.
Remote chips say “Chromium Googlesource” and use no forge logo. The repository
identity chip retains its hostname-derived label. Browser recognition is an
explicit, renderer-only rule; it does not register a forge or infer support for
other Googlesource instances, review hosts, or arbitrary Git servers.

Current limits:

- The Clone dialog rejects a pasted `git clone …` command and defaults to SSH.
  Select HTTPS explicitly. Its generic SSH candidate is not evidence of SSH
  support on this host; this change does not add or validate that transport.
- Clone reconstructs SSH/HTTPS URLs from host and project coordinates; it does
  not preserve arbitrary URL ports, credentials or special paths. Existing
  project-path rules require at least two components. This change covers V8's
  documented nested path, not every Gitiles project or URL form.
- A plain clone is useful for browsing history but is not a build-ready V8
  workspace. Follow V8's depot_tools checkout instructions (`fetch v8`) to
  obtain dependencies and setup.
- There is no PwrGit Gerrit sign-in, account enumeration, fork creation,
  change upload, review status, patch-set checkout, or commit-queue support.

`ForgeKind` currently enumerates GitHub, GitLab and GitCafe. Its product table,
repository providers and review providers are coordinated integrations;
`ForgeCapabilities` describes refinements such as batched lookups and fork
options, not a complete set of independently optional features. Adding a Gerrit
kind simply to display a logo would misrepresent these contracts. Future Gerrit
support needs explicit capability boundaries for browsing, authentication,
repository operations and review operations, plus Gerrit-specific change and
patch-set semantics. The browser-only rule leaves that decision open.
