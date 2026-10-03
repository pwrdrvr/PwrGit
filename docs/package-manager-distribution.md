# Winget and Homebrew distribution

GitHub Releases in `pwrdrvr/PwrGit` are the artifact authority. Both channels
follow **promoted, suffix-free Stable Latest**. Do not cut or promote a release
solely to populate a package manager. Alpha, beta and Stable candidates continue
to use the in-app channels.

| Channel | Identifier | Authoritative source | Ownership |
|---|---|---|---|
| Winget | `PwrDrvr.PwrGit` | [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs/tree/master/manifests/p/PwrDrvr/PwrGit) | Microsoft review; initial submissions from `huntharo` |
| Homebrew | `pwrdrvr/tap/pwrgit` | [pwrdrvr/homebrew-tap](https://github.com/pwrdrvr/homebrew-tap/blob/main/Casks/pwrgit.rb) | PwrDrvr organization |

Use a cask for the desktop app and reuse the existing PwrDrvr tap. Reconcile any
future central Homebrew cask or alternate Winget identity before updating; never
create duplicate registrations.

## Before every release

Run `pnpm distribution:audit` even for prereleases, before editing release
metadata. Retain its timestamped JSON with the release checklist. It compares
GitHub Latest, Winget version directories, the tap cask, central Homebrew and open
submission PRs; it rejects downgrades and ambiguous identities. A 403, timeout or
incomplete search is not package absence. Inspect existing submissions and their
ownership; reuse a pending PR instead of creating another for the same version.
Maintenance releases below Latest leave globally shared package channels on the
higher stable version.

## After publication and promotion

For prereleases, record both channels as intentionally unchanged and compare them
again against Stable Latest. After stable promotion, dispatch the workflow even
if a `release: edited` event already ran it:

```sh
gh workflow run package-distribution.yml --repo pwrdrvr/PwrGit --ref main
gh run list --repo pwrdrvr/PwrGit --workflow package-distribution.yml --limit 5
pnpm distribution:prepare vX.Y.Z node_modules/.cache/pwrgit-distribution
```

The workflow runs on stable publication/promotion/edit and daily. Its `homebrew`
job dispatches the tap publisher and waits up to 20 minutes for the target to
appear on tap `main`, stopping early on a failed tap run. Its summary names the
channel, target and direct tap run link on failure. Daily freshness checks run
after Homebrew synchronization so pending Winget review does not prevent tap
publication. Events emitted by `GITHUB_TOKEN` cannot be relied on to start another
workflow; the explicit dispatch above remains part of promotion through the skill.

The generator accepts only public Stable Latest. It downloads arm64 and universal
DMGs and the signed Windows x64 NSIS installer, hashes actual bytes, checks size
and GitHub SHA-256 asset digests, and cross-checks `PwrGit-windows-SHA256SUMS`.
Generated manifests use immutable versioned URLs. Never use aliases or
`releases/latest/download/`, invent a checksum, or substitute an unsigned preview.

Output contains `Casks/pwrgit.rb`, three Winget files under
`manifests/p/PwrDrvr/PwrGit/X.Y.Z/`, and `distribution-status.json`. The workflow
uploads them as `package-manager-submissions`. Winget submission remains a
maintainer/upstream-review operation. Homebrew publication is handled automatically
by the tap workflow below. Read-only generation prefers the organization Actions
secret `DISTRIBUTION_READ_TOKEN`, already shared with PwrGit, PwrSnap and PwrAgent.
If creating or rotating this secret, use an expiring fine-grained PAT limited to
public repository access and no additional permissions. GitHub's code-search endpoint
does not require fine-grained permissions. Do not reuse a release-publishing or
administrator credential for these read-only checks. Rotate the organization
secret and preserve its selected-repository access.
Never print or copy its value into a workflow or run log.

The audit steps prefer this secret and log only its name; fork PRs retain the
workflow-token fallback because repository secrets are unavailable there.
Superseded runs for the same ref are canceled to reduce redundant searches.
HTTP 429 is a rate-limit response, not proof of missing repository permission.
A PAT changes the authentication/quota source but does not remove GitHub's
code-search or secondary limits. Preserve failures and investigate throttling
if it persists. See [GitHub's code-search authentication reference](https://docs.github.com/en/rest/search/search#search-code)
and [rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
A green generation run does not prove either channel is published.

## Artifact and installation gates

| Platform | Required evidence |
|---|---|
| Apple Silicon | arm64 DMG digest; arm64 executable; matching bundle ID/version; Developer ID signature and Gatekeeper acceptance |
| Intel | universal DMG digest; x86_64 and arm64 slices; same identity/version/signature checks |
| Windows | x64 installed payload; Valid PwrDrvr LLC Authenticode on installer and app; checksum matching GitHub and release checksum file |

The workflow verifies both DMGs and validates Winget with the official client. It
installs silently for the user, checks registry name/publisher/version, checks the
installed PE machine and uninstalls. On updates it first installs the prior indexed
package when the manifest repository contains an older version. Initial registration
has no indexed predecessor: record upgrade validation as unavailable, then test
older-to-newer on the next update. An index/repository disagreement is a propagation
gate, not permission to skip upgrade validation. NSIS's bootstrapper is x86; the
installed payload determines the manifest's x64 architecture.

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

After merge run:

```sh
pnpm distribution:audit --check
winget source update --name winget
winget show --id PwrDrvr.PwrGit --exact --source winget
winget install --id PwrDrvr.PwrGit --exact --source winget --scope user
winget upgrade --id PwrDrvr.PwrGit --exact --source winget
brew update
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
