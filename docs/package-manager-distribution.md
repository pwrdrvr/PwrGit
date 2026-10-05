# Winget and Homebrew distribution

GitHub Releases in `pwrdrvr/PwrGit` are the artifact authority. Both channels
follow **promoted, suffix-free Stable Latest**. Do not cut or promote a release
solely to populate a package manager. Alpha, beta and Stable candidates continue
to use the in-app channels.

| Channel | Identifier | Authoritative source | Ownership |
|---|---|---|---|
| Winget | `PwrDrvr.PwrGit` | [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs/tree/master/manifests/p/PwrDrvr/PwrGit) | Proposed ID, not yet indexed; `huntharo` submits, Microsoft reviews/indexes |
| Homebrew | `pwrdrvr/tap/pwrgit` | [pwrdrvr/homebrew-tap](https://github.com/pwrdrvr/homebrew-tap/blob/main/Casks/pwrgit.rb) | `huntharo` / PwrDrvr tap maintainers; registration PR #8 pending |

Use a cask for the desktop app and reuse the existing PwrDrvr tap. Reconcile any
future central Homebrew cask or alternate Winget identity before updating; never
create duplicate registrations.

## Before every release

Run `pnpm distribution:audit --output <ignored-directory>/distribution-
audit.json` even for prereleases, before editing release metadata. Retain its
timestamped JSON with the release checklist. It compares GitHub Latest and its
asset metadata, remote Winget installer manifests, the tap cask, code search
across central Homebrew casks/formulae and all submission PR history; it rejects
downgrades and ambiguous identities. For existing packages it verifies
architecture-selected immutable URLs and SHA-256 against the corresponding
published GitHub release, including older versions. `prepare` additionally
downloads and hashes the actual bytes. A 403, timeout or incomplete search is
not package absence. Inspect existing submissions and their ownership; reuse a
pending PR instead of creating another for the same version. Maintenance
releases below Latest leave globally shared package channels on the higher
stable version.

## After publication and promotion

For every publication, including alpha, beta and Stable candidates, record both
channels against Stable Latest again. Prereleases intentionally leave both
packages unchanged. The existing workflow's `audit` job runs for every published
or edited release, separately from opt-in native validation. `release.yml`
also reuses this same workflow with `audit_only: true` before preparation and
after publication, retaining `distribution-audit-before-release` and
`distribution-audit-after-publication`. A preflight blocker stops release
preparation; a post-publication blocker requires an owned retry and does not
mean the GitHub release needs republishing. A read-only manual check does not
download artifacts or install an app:

```sh
gh workflow run package-distribution.yml --repo pwrdrvr/PwrGit --ref <audit-branch> -f audit_only=true
gh run list --repo pwrdrvr/PwrGit --workflow package-distribution.yml --branch <audit-branch>
```

Inspect `Audit authoritative public distribution sources` and download its
`distribution-audit-standalone` artifact. It retains complete comparisons or
sanitized blockers even when the audit fails. `status: complete` means remote
reads/searches completed, not that packages are current or clients have
installed them. `audit --check` requires both remote package versions to equal
Stable Latest. After stable promotion, dispatch the workflow even if a `release:
edited` event already ran it:

```sh
gh workflow run package-distribution.yml --repo pwrdrvr/PwrGit --ref main
gh run list --repo pwrdrvr/PwrGit --workflow package-distribution.yml --limit 5
```

The workflow audits all publication/promotion/edit events, PR changes and daily
runs using metadata only. Its `homebrew`
job dispatches the tap publisher and waits up to 20 minutes for the target to
appear on tap `main`, stopping early on a failed tap run. Its summary names the
channel, target and direct tap run link on failure. Daily freshness checks run
after Homebrew synchronization so pending Winget review does not prevent tap
publication. Events emitted by `GITHUB_TOKEN` cannot be relied on to start another
workflow; the explicit dispatch above remains part of promotion through the skill.

Routine audits do not request release asset bytes and therefore do not add
installer downloads to GitHub statistics. Synchronization reads metadata and
returns when the tap is already current. A needed tap update verifies both DMGs
using its installer cache; cache misses download release bytes. Keep those validation downloads
separate from estimates of user adoption.

Native validation and Winget submission-file generation are explicit operations,
not daily/PR/release-event checks. When published-byte or installation evidence
is needed, run once on disposable runners:

```sh
gh workflow run package-distribution.yml --repo pwrdrvr/PwrGit --ref main -f validate_assets=true
```

This plans manifests from metadata, then verifies both DMGs, the Windows installer
and its checksum file. Exact installer caches avoid repeated downloads; Windows
reuses the verified installer in WinGet's temp cache and may install an indexed
predecessor for upgrade validation. Cache misses add GitHub release downloads. `audit_only=true`
overrides `validate_assets=true` and skips them. For local manifest generation,
`pnpm distribution:prepare vX.Y.Z node_modules/.cache/pwrgit-distribution` reuses
verified cached installers and the checksum file.
Reuse the generated submission files/evidence instead of repeating checks just
to reconfirm unchanged sources. PR CI covers the generator with fixture tests.

The generator accepts only public Stable Latest. It downloads arm64 and universal
DMGs and the signed Windows x64 NSIS installer, hashes actual bytes, checks size
and GitHub SHA-256 asset digests, and cross-checks `PwrGit-windows-SHA256SUMS`.
Generated manifests use these exact URL patterns (`X.Y.Z` is the audited tag):

- `https://github.com/pwrdrvr/PwrGit/releases/download/vX.Y.Z/PwrGit-X.Y.Z-arm64.dmg`
- `https://github.com/pwrdrvr/PwrGit/releases/download/vX.Y.Z/PwrGit-X.Y.Z-universal.dmg`
- `https://github.com/pwrdrvr/PwrGit/releases/download/vX.Y.Z/PwrGit-X.Y.Z-windows-x64-setup.exe`
- `https://github.com/pwrdrvr/PwrGit/releases/download/vX.Y.Z/PwrGit-windows-SHA256SUMS`

The timestamped JSON inventory retains the resolved URLs, byte counts and
hashes; compare `shasum -a 256 <download>` (macOS) or `Get-FileHash -Algorithm
SHA256` (Windows) with the generated manifest/cask and GitHub digest before
submission. Never use aliases or `releases/latest/download/`, invent a checksum,
or substitute an unsigned preview.

Daily runs retain publication and identity audits without native validation.
An absent Winget registration still fails `audit --check` even when Homebrew is
current; generated manifests do not constitute an upstream submission. Explicit
native runs reuse successful validation for identical release bytes, manifests,
validator inputs and runner platform. Each platform records success only after
its full checks. On an opted-in run, new releases, changed inputs, a changed
Winget upgrade baseline or a missing success cache trigger validation. Installer
cache restores are hashed and size-checked; WinGet uses the verified installer
for local-manifest installation. There are no fallback cache keys. PR records
cannot bless main. Cache eviction never enables native checks on routine audits.

To explicitly repeat native checks while retaining verified installer caches:

```sh
gh workflow run package-distribution.yml --repo pwrdrvr/PwrGit --ref main -f validate_assets=true -f force_validation=true
```

`force_validation` alone does not enable native validation.

Output contains `Casks/pwrgit.rb`, three Winget files under
`manifests/p/PwrDrvr/PwrGit/X.Y.Z/`, and `distribution-status.json`. The workflow
uploads them as `package-manager-submissions`. Winget submission remains a
maintainer/upstream-review operation. Homebrew publication is handled automatically
by the tap workflow below. Public cross-repository API/search/release reads use
`GH_TOKEN: ${{ secrets.DISTRIBUTION_READ_TOKEN || github.token }}`. The existing organization
Actions secret is shared with `pwrdrvr/PwrGit`, `pwrdrvr/PwrSnap` and
`pwrdrvr/PwrAgent` using selected repository visibility. It contains a dedicated
expiring fine-grained PAT restricted to public repositories, with no additional
permissions. Keep publishing, fork pushes, submission and tap merges on their
separate authorized credentials; never substitute this token for `RELEASES_PAT`
or widen its permissions. Fork checks without organization secrets retain
`GITHUB_TOKEN`. See [GitHub secret access
policies](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

Verify configuration using metadata only:

```sh
gh api orgs/pwrdrvr/actions/secrets/DISTRIBUTION_READ_TOKEN
gh api orgs/pwrdrvr/actions/secrets/DISTRIBUTION_READ_TOKEN/repositories --jq '.repositories[].full_name'
```

Then dispatch `audit_only=true` and verify the log reports
`DISTRIBUTION_READ_TOKEN; organization secret available: true`, the audit succeeds,
and the artifact confirms public repository metadata, sources and complete search
reads. Secret listing alone does not prove runtime availability. Never retrieve,
print, copy or log the value. Superseded runs for the same ref are canceled.

HTTP 429 indicates throttling, not missing public access. The PAT still has
code-search and secondary limits. The helper permits three attempts per request,
respects `Retry-After` and primary reset headers, waits at least 60 seconds for
secondary throttling/incomplete search, and bounds waits at 120 seconds each and
180 seconds total per request. A longer required delay stops the audit; it never
retries early to evade the limit. Every code and issue search must have
`incomplete_results=false`, consistent counts, unique results and full
pagination within GitHub's 1,000-result cap. Exhaustion, truncation or unstable
results are blockers: `huntharo` inspects the source/rate-limit state and reruns
after reset; no absence or publication claim is allowed. See [code
search](https://docs.github.com/en/rest/search/search#search-code) and [GitHub
rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-
the-rest-api).

`huntharo` and PwrDrvr organization maintainers own the token lifecycle. Keep an
organization-maintainer-controlled expiry inventory recording the token owner,
expiration, renewal reminder, selected repositories, public-only/no-extra-
permissions policy, rotation date and verification run URLs, without storing its
value. GitHub secret metadata exposes update time, not PAT expiry; confirm
expiry in the owner's token settings rather than inferring it. Before expiry,
renew/rotate under the same `DISTRIBUTION_READ_TOKEN` name and access policy.
After rotation, repeat metadata/sharing checks and read-only runtime audits in
each selected repository; record run URLs and retire the previous token only
after successful verification. See [GitHub token
management](https://docs.github.com/en/authentication/keeping-your-account-and-
data-secure/managing-your-personal-access-tokens). A green generation run does
not prove either channel is published.

## Artifact and installation gates

| Platform | Required evidence |
|---|---|
| Apple Silicon | arm64 DMG digest; arm64 executable; matching bundle ID/version; Developer ID signature and Gatekeeper acceptance |
| Intel | universal DMG digest; x86_64 and arm64 slices; same identity/version/signature checks |
| Windows | x64 installed payload; Valid PwrDrvr LLC Authenticode on installer and app; checksum matching GitHub and release checksum file |

The explicit `validate_assets=true` run verifies both DMGs and validates Winget with the official client. It
installs silently for the user, checks registry name/publisher/version, checks the
installed PE machine and uninstalls. On updates it first installs the prior indexed
package when the manifest repository contains an older version. Initial registration
has no indexed predecessor: record upgrade validation as unavailable, then test
older-to-newer on the next update. An index/repository disagreement is a propagation
gate, not permission to skip upgrade validation. NSIS's bootstrapper is x86; the
installed payload determines the manifest's x64 architecture.

Follow the current [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook)
and [livecheck guidance](https://docs.brew.sh/Brew-Livecheck). `:github_latest`
is appropriate here because PwrGit packages promoted Latest release assets.
Tap CI must style/audit online, install, verify signatures/Gatekeeper and uninstall
on Intel and Apple Silicon. On later updates test
`brew upgrade --cask --greedy pwrdrvr/tap/pwrgit` from the previous version on a
disposable machine. `--greedy` exercises an `auto_updates true` cask. Close the app
before replacement; verify retained settings and repositories afterward. Ordinary
uninstall must retain user data. Use the dedicated lab for headed launch and
retained-data checks per `apps/desktop/e2e/AGENTS.md`; installer CI alone does not
prove launch.

## Submit updates

For Winget follow the current [Microsoft submission guide](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)
and [first contribution checklist](https://github.com/microsoft/winget-pkgs/blob/master/doc/FirstContribution.md).
Recheck the recommended schema in the upstream PR template; it currently selects
1.12 although the documentation also lists 1.28. The generator follows that
community-repository recommendation. Run `winget validate --manifest <version-directory>`, enable local
manifests with `winget settings --enable LocalManifestFiles` (elevation required),
and install the manifest. Use Windows Sandbox when policy blocks local manifests.
Capture actual per-user registry metadata for NSIS `/currentuser`; do not guess an
MSI ProductCode or advertise Windows arm64 support.

Fork `microsoft/winget-pkgs`, branch, copy only the generated three files for one
version to the canonical path and open a PR using its template. Leave unperformed
validation boxes unchecked. Reuse the identifier on subsequent updates. The
authenticated maintainer needs push access to their fork; initial submission
ownership is `huntharo`. CLA, malware checks and manual review are external gates.

### Homebrew: automatic validated publication

The tap owns the cask update. Merge its initial registration/setup PR once.
Subsequent promoted Stable Latest versions follow this path:

1. PwrGit's promotion event runs `package-distribution.yml`; the release skill
   also dispatches it explicitly when it promotes with CLI credentials.
2. The `homebrew` job dispatches tap `bump-pwrgit.yml` on `main` for the target.
3. The tap checks immutable DMG bytes and runs cask style/online audit,
   install/upgrade, bundle identity, architecture, signing/Gatekeeper and uninstall
   on Intel and Apple Silicon. Failed gates preserve the published version.
4. After both architecture jobs pass, the tap's own `GITHUB_TOKEN` updates only
   `Casks/pwrgit.rb` on tap `main`. It rechecks Latest/artifact metadata and uses
   the previous cask SHA to reject concurrent changes. There is no routine update
   PR, workflow approval or merge step.
5. PwrGit verifies tap `main` reached the target and reports the result in its
   `homebrew` job summary. Users receive it after `brew update`; fresh client
   installation remains the final client check.

The tap also checks Latest every 15 minutes, skipping expensive Mac validation
when unchanged. GitHub schedules can be delayed; immediate dispatch is the normal
promotion path. A tap failure opens one issue per outage with the failed run and
recovery action. Resolve that run and dispatch the same publisher; do not create
another bump PR.

**Immediate dispatch credential:** create a fine-grained PAT with resource owner
`pwrdrvr`, repository access **Only select repositories → homebrew-tap**, and
repository **Actions: Read and write**. No Contents write permission is needed.
Give it an expiration and store it as `HOMEBREW_TAP_DISPATCH_TOKEN` in PwrGit's
Actions secrets, or as an organization secret shared with PwrGit. This token only
starts the tap's trusted workflow; the public-read `DISTRIBUTION_READ_TOKEN`
cannot do so. Missing or expired credentials produce an explicit failure summary
with the tap workflow link. The schedule still reconciles once tap setup is live.

An agent promoting through the release skill can dispatch directly with the
maintainer's existing CLI authentication:

```sh
gh workflow run bump-pwrgit.yml --repo pwrdrvr/homebrew-tap --ref main -f version=X.Y.Z
gh run list --repo pwrdrvr/homebrew-tap --workflow bump-pwrgit.yml --limit 5
```

Record the run URL, follow its checks and verify the cask on tap `main`. Do not
call a dispatch, artifact upload or still-open registration PR publication.

## Verify publication and pending work

After merge run on disposable Windows/macOS clients, never over the operator's live app:

```sh
pnpm distribution:audit --check
winget source update --name winget
winget show --id PwrDrvr.PwrGit --exact --source winget
winget install --id PwrDrvr.PwrGit --exact --source winget --scope user
winget upgrade --id PwrDrvr.PwrGit --exact --source winget
brew update
brew tap pwrdrvr/tap
brew info --cask pwrdrvr/tap/pwrgit
brew install --cask pwrdrvr/tap/pwrgit
brew upgrade --cask --greedy pwrdrvr/tap/pwrgit
```

Record client versions, architecture-selected URLs/checksums and installed
versions. Distinguish **submitted**, **merged**, **indexed/cache refreshed** and
**install/upgrade verified**. Winget's Git repository and client index are separate;
merge does not prove discoverability. For Homebrew inspect the remote default
branch before blaming local cache. Do not call setup live until fresh client
discovery and installation succeed.

Retain one row per channel: target/remote/client versions, submission and check
URLs, review/index/cache state, blocker, owner and next action. Monitor existing
PR checks/comments, address changes and refresh sources after publication. If a
signed installer, promoted stable release, account permission or CLA is unavailable,
report that exact dependency while keeping completed setup reviewable.

## Initial setup audit (2026-10-02)

The promoted artifact source is [v0.27.0](https://github.com/pwrdrvr/PwrGit/releases/tag/v0.27.0).
The audit found no PwrGit Winget manifests or prior submissions, no central
Homebrew cask or prior submission, and only PwrSnap in the existing PwrDrvr tap.
Both macOS DMGs and the Windows x64 installer were downloaded and SHA-256 checked;
both macOS bundles passed strict signature and notarized Gatekeeper checks.

| Channel | Published package version at audit | Target | Submission | State / next action |
|---|---|---|---|---|
| Winget | None | 0.27.0 | Preparation in this PR | Run native validation, submit to Microsoft and track review/index publication |
| Homebrew | None | 0.27.0 | [tap PR #8](https://github.com/pwrdrvr/homebrew-tap/pull/8) | PwrGit Intel/Apple Silicon install/signature/uninstall checks [passed](https://github.com/pwrdrvr/homebrew-tap/actions/runs/37006517071); review and merge, refresh tap and verify client install |

The same tap run fails its existing PwrSnap audits because that cask is 1.1.2
while PwrSnap Latest is 1.1.12. This sibling version is unchanged in the PwrGit
submission; the tap maintainer must resolve that separate drift before treating
the combined tap check as green.

These are initial registration records, not proof of live distribution. The
maintainer `huntharo` owns submission follow-up. Update this dated snapshot with
submission/check URLs and evidence as review and publication advance; use the
live audit rather than this snapshot when preparing subsequent releases.

## Follow-up audit (2026-10-03, before registration updates)

The complete remote audit selected
[v0.29.0](https://github.com/pwrdrvr/PwrGit/releases/tag/v0.29.0). The public
Winget manifest path is absent; complete code and submission-history searches
found no PwrGit identity or submission. Central Homebrew cask and formula
searches found no PwrGit source. The PwrDrvr tap default branch still has no
`Casks/pwrgit.rb`; [tap PR #8](https://github.com/pwrdrvr/homebrew-tap/pull/8)
remains open with version 0.27.0 and its bump workflow. Its PwrGit Intel/Apple
Silicon checks passed, while the combined tap run remains blocked by the sibling
PwrSnap checks described above. No package submissions or tap merges were made
for this audit improvement.

| Channel | Target | Remote / client version | Owner | Blocker / next action |
|---|---|---|---|---|
| Winget `PwrDrvr.PwrGit` (proposed) | 0.29.0 | No remote registration / client unverified | `huntharo`; Microsoft review/index after submission | Generate and validate current signed assets, submit one version, record PR/check URLs; follow CLA/review/index and verify fresh client install. Initial upgrade has no indexed predecessor. |
| Homebrew `pwrdrvr/tap/pwrgit` (pending) | 0.29.0 | No default-branch cask / client unverified; PR #8 is 0.27.0 | `huntharo` / PwrDrvr tap maintainers | Update the existing registration PR to current Latest, resolve combined tap CI, review/merge, then refresh the tap and verify installs on both architectures. Bump automation is unavailable until that PR lands. |

Use the live timestamped audit for subsequent releases; these dated observations
are not current publication evidence. Add submission/check/run URLs, source and
client versions, pending review/index/cache delays, exact owner/action and final
installation evidence to each release's retained checklist.
## Registration follow-up (2026-10-03)

Stable Latest is now v0.29.0. Tap PR #8 has been updated to its actual downloaded
DMG hashes and the automatic publisher; publication still requires its initial
merge. The owner squash-merged PwrSnap 1.1.14 in tap PR #10, resolving the stale
PwrSnap version that failed the original combined checks. Both casks and both
PwrGit publisher architecture checks subsequently passed in
[CI](https://github.com/pwrdrvr/homebrew-tap/actions/runs/37140449391) and
[the publisher dry run](https://github.com/pwrdrvr/homebrew-tap/actions/runs/37140449420).
Publication was skipped because these are PR runs. A separate tap child
PR scopes registration CI to changed casks. Use current run results rather than
the historical October 2 checks above.
