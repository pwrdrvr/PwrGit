# Contribution analytics

PwrGit’s **Contributions** navigation opens local activity analytics for an
existing authenticated forge account. GitHub is the first provider, including
configured Enterprise hosts. No new token, signup, hosted analytics, telemetry
contents or forge mutations are introduced. GitLab and GitCafe are explicitly
unavailable until they implement equivalent verified reads.

## Measures and dates

**PRs merged by me** compares the actual GraphQL `mergedBy` immutable node ID
with verified `viewer.id`. **My PRs that were merged** compares `author.id`,
regardless of merger; their intersection is counted once. **My PRs created**
uses author identity and `createdAt`. Actor login is verified alongside ID on
every request. Bots, null/deleted actors, auto-merge and merge queues are never
inferred human actions. REST bot login suffixes differ from GraphQL; stable actor
IDs avoid that ambiguity.

The default begins six calendar months before today in the selected timezone,
clamping month ends, and ends yesterday. Editable dates and IANA timezone permit
up to 366 dates. **Since August 1** selects the most recent August 1 through now.
UTC `[start,end)` bounds freeze when collection begins; including today freezes
an actual as-of timestamp and visibly labels the partial day. Complete-day
averages exclude today’s events and denominator; inclusive calendar-date
averages include it. Neither denominator is elapsed 24-hour periods. Civil
midnights and zero-filled days handle 23/25-hour DST days. Date formatters are
reused per timezone in a bounded 16-zone cache, avoiding ICU initialization for
every aggregation row.

Daily/weekly/monthly bars stack namespaces or repositories with top-N plus
Other, filters, totals and an accessible exact table. Weekly buckets start
Monday; edge buckets include selected dates only. Bars/table periods drill into
PR numbers, repositories and timestamps. CSV exports exactly the displayed
buckets, timezone, measure and coverage; JSON also includes matching metadata
and author flow. Author flow has its own exact table/CSV. Downloads are
explicit and local; CSV cells guard formula injection.

## Share image

**Share image…** on the chart opens a sheet that previews a picture meant for
pasting into chat or a post, and copies it as a 1800×760 PNG (or saves it).
The picture stacks by organization, by repository (top 8 + Other), or shows
the total only, with no names at all. Each namespace is shown or masked on its
own: masked orgs become Org A, Org B… by volume, their repositories Org
A/repo 1…, and other people's personal namespaces User A…. **Everything starts
masked except the viewer's own personal namespace**, so a reflexive Copy never
names an employer. Choices persist per profile, host and account in
`localStorage`; nothing about them is sent anywhere.

Names are resolved in `packages/shared/src/contribution-share.ts` before the
picture is drawn, and the picture is a standalone SVG built from those labels
alone (no live DOM, no `<title>` tooltips, no metadata), rasterized through a
canvas and handed to the existing `clipboard:writeImage` IPC. The preview is
that same SVG, so what the user checks is what they paste. The earlier
"Export chart" SVG download is gone: it cloned the on-screen chart, carried
every org and repository name in per-bar tooltips, and had no legend.

Creation/backlog compares **authored creations** with **authored PRs merged by
anyone**, never with the different merger population. Lifetime visible author
metadata and closed/reopened/merged history reconstruct OPEN stock at the
selected baseline, daily endings and cutoff. Closed-unmerged transitions,
reopenings and terminal CLOSED stock are separate. Total created-not-yet-merged
includes terminal closed PRs; the selected creation cohort separately reports
its merge percentage by cutoff. A cumulative created-minus-merged flow gap is
explicitly not backlog. Recent cohorts have had less time to merge, so age
matters when interpreting their merge percentages. Incomplete histories do not publish complete stock.

## Direct provider and completeness

The provider supplies identity, repository/organization inventories, native
merged PR pages, lifetime authored PR pages and filtered lifecycle pages. It
uses existing hardened `runGh` authentication/transport and forge host gates.
Every request verifies the same viewer ID and login; no credentials are read
out of the auth store.

Repository enumeration explicitly sets **both** `affiliations` and
`ownerAffiliations` to `[OWNER,ORGANIZATION_MEMBER,COLLABORATOR]`; the latter’s
OWNER default silently loses collaborator/org projects. Forks, archived repos,
visibility, owner type and immutable IDs are retained. Received and distinct
counts must match stable `totalCount`; changing counts, duplicate IDs, missing
cursors, partial GraphQL errors and lost access stop with incomplete coverage.
Organizations provide membership context, not a sweep of all public org repos.

Merger reads use repository node IDs and
`pullRequests(states:MERGED,first:100,orderBy:UPDATED_AT DESC)`. Process the whole
page, filter actual `mergedAt` against the frozen window, then stop when its
oldest `updatedAt` predates start. Old merges recently edited do not enter the
result. Deduplicate immutable repository + PR IDs. Search is not used: GitHub
has no `merged-by:` qualifier, caps issue search at 1,000, and has demonstrably
omitted a valid merged PR despite count agreement and `incomplete_results=false`.

Author reads use lifetime `viewer.pullRequests`, all three states, ordered by
`CREATED_AT`; **every node’s author ID is checked** against viewer ID. Stable
`totalCount`, received and distinct counts must agree. This includes visible
personal/external authored projects without scanning their unrelated PRs.
Old merged-before-start rows can be discarded; older OPEN/CLOSED rows are kept
for stock baselines. A terminal CLOSED PR last updated before start has a frozen state
for this interval; all currently OPEN and remaining authored candidates need
lifecycle history.

Lifecycle reads request only CLOSED/REOPENED/MERGED timeline items, IDs and state
event timestamps, in batches of up to 25 PRs. **First-page `filteredCount`** pins
the expected count. Subsequent cursor-scoped `filteredCount` may shrink and is
not asserted identical. Exhaust pagination, reject repeated IDs, and compare
received distinct events with that initial expectation. `totalCount` counts
neither filtered events nor all UI timeline nodes and cannot validate either.
Completed history must reconcile with recorded state and contain exactly one
terminal merge event for a merged PR. Scalar `mergedAt` supplies merge cutoffs
and buckets; the merge event can lag by a second. A close paired at the merge
event or scalar timestamp is suppressed rather than counted as closed-unmerged.
No comments, titles, bodies or review text are fetched.

“Finished for visible inventory” describes accessible metadata, not inaccessible
history. Merger coverage traverses current affiliated repositories, plus known
viewer-authored external merges. Other-author merges in external/former-access
projects remain unverified. Direct author coverage includes visible personal
and external projects; deleted/inaccessible PRs remain unknown. SSO and permission
failures are errors, never zero. Personal namespaces remain distinct from orgs;
owner labels reflect current ownership, not historical transfers. GitHub pages
are not a transactional snapshot: frozen cutoff, ID checks and state/count
checks detect some concurrent changes; refresh recollects when inconsistent.

GitLab’s documented `merge_user` and `merged_at` can support a later adapter
(`merged_by` is deprecated), with its own identity/access/history validation.
Unsupported forges never borrow GitHub semantics.

## Schema, privacy and limits

Migration `0042_contribution_snapshots.sql` stores versioned JSON checkpoints in
SQLite under **profile + canonical host + viewer ID + dates/timezone**. Profile
foreign keys cascade on deletion. Metadata contains frozen UTC bounds, verified
identity, repo/organization inventory, author inventory counts/IDs/cursor,
merger repository index/cursor, lifecycle events/first filtered count/cursors,
pages, retry time, coverage status/issues and collection timestamps. Persisted
PRs reference repository IDs rather than duplicate repository metadata. API
error payloads, credentials and content are neither stored nor logged.

Successful pages checkpoint atomically. Cancellation, failures and interrupted
processes remain incomplete. Resume re-verifies identity and preserves original
bounds/cursors; refresh replaces the selected snapshot with visibly collecting
data. Charts/filter renders aggregate local rows; polling reads SQLite only.
Disabling a forge host stops network reads while preserving profile-scoped
cache reads, cancellation and deletion. Successful repository/commit/file
navigation leaves Contributions, including incoming reveals of an already
selected repository.
One collector runs app-wide, sequentially, with 150ms request spacing, a 45s
subprocess timeout and up to two transient timeout/5xx retries using existing
forge backoff. A pass pauses at 1,000 pages and can resume. Quota below 200 stops
until GitHub’s reset time. Auth/SSO/403/429/schema failures stop immediately.

Bounds: 10,000 repositories, 20,000 lifetime authored IDs and retained PRs,
2,000 lifecycle events per PR and 50,000 events per snapshot. Limit failures
remain partial. Four recent range/account snapshots per profile are retained
for 30 days; lazy expiry runs on read/write, and account cache can be explicitly
cleared. Profiles, accounts and hosts never share snapshots.

## Validation

Invented fixtures cover >1,000 direct records and a count-consistent search
omission, author/merger/overlap, bot IDs/null actors, UTC/local midnight and DST,
leap/month-end defaults, zero filling, partial today, shifted historical
baselines/reopens/closed stock, external lifetime author inventory, both repo
filters, missing/repeated cursors, changing counts, filtered timeline counts,
SSO failures, cancellation/resume and profile/account/host isolation. UI tests
compare chart/table/export totals and exercise explicit sync and cancellation.
Visual and accessibility checks use only contrived account/repository data.

References: [GitHub User](https://docs.github.com/en/graphql/reference/users#user),
[GitHub Repository](https://docs.github.com/en/graphql/reference/repos#repository),
[GitHub PullRequest](https://docs.github.com/en/graphql/reference/pulls#pullrequest),
[GitHub PullRequestTimelineItemsConnection](https://docs.github.com/en/graphql/reference/pulls#pullrequesttimelineitemsconnection),
[GitLab merge requests](https://docs.gitlab.com/api/merge_requests/).
