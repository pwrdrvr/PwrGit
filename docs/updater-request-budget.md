# Production updater request audit — 2026-09-30

Scope: the PwrGit 0.25.0 source on PR #364 and its pinned
`electron-updater@6.8.9`. Counts below come from inspected request paths and
stubbed, fake-clock regression tests. No live release API probes were used.
Older installed binaries keep their existing behavior until upgraded.

## What the overnight errors establish

The reported 2026-09-29 23:50 and 2026-09-30 00:50 America/New_York errors
(03:50Z and 04:50Z on September 30, with resets at 04:05:18Z and 05:05:18Z)
are consistent with one hourly updater encountering exhausted quota. They
do not identify which applications or machines consumed that quota. This
audit found a possible amplifier, not evidence attributing those incidents.

GitHub associates unauthenticated REST requests with the originating public
IP and allows 60/hour. Authenticated personal-token requests normally share
a 5,000/hour user budget. PwrGit's updater uses `GH_TOKEN`, then `GITHUB_TOKEN`;
it does not obtain a token from `gh auth` or the app's forge connections.
The historical process's authentication mode is not established here.
[GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

A 304 is still a request. GitHub only guarantees exemption from primary
quota for a correctly authenticated conditional request returning 304.
The old code comments omitted that qualification. Anonymous capacity planning
must include conditional requests.
[GitHub conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).

## Requests and endpoints

`auto-updater.ts` is the sole owner of the release list; all renderer reads go
through IPC. It sends one GET to
`https://api.github.com/repos/pwrdrvr/PwrGit/releases?per_page=30`.
There is no pagination loop, separate `/latest` lookup, per-tag REST lookup,
or `/rate_limit` probe. All four channel tiles derive from this one list.

| Check outcome | REST release-list GETs | Additional network work |
| --- | ---: | --- |
| Automatic check deferred, or eligible download already held in memory | 0 | 0 |
| Current version is at least the selected release, or no eligible release | 0 if cached; otherwise 1 | 0 |
| Newer eligible release | 0 if cached; otherwise 1 | One generic-provider metadata GET, then download work if needed |
| Explicit Check for Update / menu check | 1, even with fresh cache | Download work only for a newer eligible release; a held eligible download or active backoff still suppresses the request |

The generic feed is pinned to
`https://github.com/pwrdrvr/PwrGit/releases/download/{selected-tag}/`.
The metadata file is `latest-mac.yml` on macOS and `latest.yml` on Windows,
possibly with a `noCache` query. These are release-asset URLs, not REST API
endpoints. Setting `allowPrerelease` does not add another list lookup or change
the generic provider's default `latest` filename.

A simple uncached full update is one REST GET + one metadata GET + one ZIP
(macOS) or installer EXE (Windows) GET before redirects. Total HTTP exchanges
are not a fixed three: GitHub redirects assets to its release/CDN hosts
(including `release-assets.githubusercontent.com`); differential downloads
fetch a new `.blockmap`, optionally an old `.blockmap`, then one or more range
requests. A differential failure can add a full download. A valid existing
payload cache can avoid the payload transfer. The generic provider retries
`ECONNREFUSED` up to three times after the first metadata attempt. macOS also
serves its downloaded ZIP to Squirrel over loopback; that is not GitHub traffic.
These asset paths do not add REST release-list requests. No live CDN trace or
fixed total download-request count is claimed.

Source evidence: `auto-updater.ts`'s `fetchGitHubReleases`,
`configureAutoUpdaterFeedForRelease`, and `runAvailableUpdateDownload`;
the pinned dependency's `GenericProvider.getLatestVersion`,
`Provider.getDefaultChannelName`, `AppUpdater.differentialDownloadInstaller`,
`MacUpdater`, and `NsisUpdater`.

## Installed version, channel and process scope

The default selection comes from `resolveUpdateSelection` in
`packages/shared/src/protocol.ts`; a saved user selection takes precedence.

| Installed version kind | Inferred train / track | Release-list requests per uncached check |
| --- | --- | ---: |
| Stable `X.Y.Z` | Stable / Latest | 1 |
| `-prerelease` or `-rc` | Stable / Prerelease | 1 |
| `-beta` | Beta / Latest | 1 |
| `-alpha` | Beta / Prerelease | 1 |
| Legacy `1.0.0-beta.*` | Stable / Latest | 1 |

The current version and chosen channel determine whether the download branch
is taken. They do not multiply the release-list requests. The persisted budget
is deliberately not keyed by installed version, tag, train, track, or profile ID.

`index.ts` calls `initAutoUpdater` once, under Electron's single-instance lock.
Ordinary profile windows and auxiliary windows share that main-process updater.
A second launch using the same userData focuses the existing instance rather
than starting another updater. A new logical PwrGit profile is not a new
updater or a new budget. Independent `PWRGIT_USER_DATA_DIR` directories are
different instances and budgets. Renderer/GPU/utility processes do not each
start an updater.

Linux never runs the automatic downloader or its hourly loop. Packaged Linux
can read the release matrix when Settings asks, so that path also needs the
persistent release-list guard. Its manual installer check remains unsupported.
Unpackaged development and E2E launches make no release-list requests and use
the existing update simulation on supported platforms. An agent launching a
packaged app used to get the immediate production check; its provenance as an
agent launch provides no exemption or extra protection.

## Before and after

Previously macOS/Windows initialization checked immediately, then every hour.
The release list, ETag, successful-fetch timestamp, in-flight deduplication,
and rate-limit reset were memory-only. There was no durable last-attempt time
or general failure backoff. Settings could fetch again after the 15-minute
cache TTL; changing train/track forced revalidation immediately. Restarting
discarded all those protections. electron-updater's separate on-disk payload
cache did not preserve PwrGit's REST request budget.

Now `userData/update-release-state.json` persists schema version, first-seen
time, last full-check/REST-attempt/success times, release metadata and ETag,
server reset, consecutive failures, and retry deadline. Writes use a temporary
file plus atomic rename; the file is created with mode 0600 where supported.
No token or Authorization header is stored. Attempt reservations are written
before contacting either transport, so a killed process cannot erase an
automatic attempt by failing to receive its response.

- New or corrupt state gets a persisted ten-minute first-check deadline.
  Restarting does not reset it. Upgrading an existing installation that has
  no state file also receives this initial delay.
- Automatic full checks and release-list fetches each have an hourly budget.
  Settings reads serve the persisted cache during that budget, even after its
  15-minute freshness window expires. A channel change applies immediately
  but does not create an extra automatic network allowance.
- The timer follows the persisted full-check deadline: ordinarily the first
  request is at ten minutes, then at seventy minutes, etc. An overdue existing
  installation can check immediately on launch; subsequent rapid restarts
  cannot replay that check. Successful downloaded offers can suppress further
  checks while that process remains open.
- Explicit button/menu checks bypass the initial delay and normal cadence.
  They still join in-flight work and honor known server reset and retry
  deadlines. Release-list errors back off for 1, 2, 4, 8, 16, 32, then at most 60 minutes;
  automatic cadence can require a longer wait. A successful response clears
  failure backoff, while a response reporting zero remaining quota preserves
  its reset even if its HTTP status was successful.
- Unwritable state prevents an unrecorded request. Missing/corrupt state
  restarts the safe initial delay. Whole-check reservations also bound
  automatic metadata/download rechecks from cached offers across restarts.

## Shared-IP arithmetic

These are REST request rates, not total CDN transfers or observed historical
quota consumption. The ranges assume one installation/userData per computer,
no explicit checks, no concurrent old binaries, and no other API consumers.

| Scenario | Before | With this guard |
| --- | --- | --- |
| One continuously running macOS/Windows app, normal idle use | One immediate GET, then 1/hour | First GET after 10 minutes for new state, then at most 1/hour |
| 4–6 such computers sharing one IP | 4–6 immediate, then 4–6/hour | 4–6 after their initial delays, then at most 4–6/hour |
| Repeated Settings reads | Up to 4/hour per process without explicit checks | At most 1/hour per userData |
| 20 sequential packaged launches/minute, same userData, no update available | 20/minute; 60 requests in three minutes | At most one automatic GET in any hour; zero during a new state's first minute |
| Same launch pattern on 4–6 computers | 80–120/minute; a previously unused 60-request bucket can be spent in about 30–45 seconds | At most 4–6/hour across those userData directories |
| 20 fresh directories, each closed within three seconds | Up to 20 immediate GETs | Zero automatic GETs |

The guard is not a public-IP coordinator. Twenty independent directories that
remain alive past ten minutes can still make twenty requests, then twenty per
hour. Six computers running twenty such directories could exceed the shared
anonymous budget. Other Pwr apps, other OS users, older binaries, other GitHub
features, and explicit checks remain independent consumers. Clearing the state
file also discards previous quota knowledge, although it reinstates the delay.
Copying an old state file into multiple directories copies its deadlines, not
a shared lock: overdue copied states can each fetch independently.

## Verification

`auto-updater.test.ts` uses a temporary real state directory, stubbed fetch and
electron-updater, reset module instances, and a fake clock. Coverage includes
20 launches/minute across version/channel changes; the ten-minute boundary and
hourly continuation; twenty fresh userData profiles and concurrent readers;
manual/menu bypass; persisted ETag + 304 payload reuse; server reset and
Retry-After across restarts; exponential failure recovery; a killed in-flight
request; corrupt/unwritable state; and suppression of all transport calls from
the unpackaged simulation. Unit and E2E GitHub transport guards remain active.

The tests prove counts at the REST and updater-check boundaries without making
real release API calls. Their fake production platform matrix does not replace
macOS/Windows packaging or live CDN/download testing. CI and local validation
results are recorded in the PR.
