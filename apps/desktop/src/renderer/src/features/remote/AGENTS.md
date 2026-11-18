# features/remote — AGENTS.md

This feature shows live status for a running fetch, pull or push. The
main-process half is `src/main/git/remote-activity.ts`. Its record, and why
`queued` and `silent` are separate facts, are in
[main/git/AGENTS.md](../../../../main/git/AGENTS.md) ("Every long-running
remote command registers an activity").

## The click opens it; the outcome closes it

Fetch, Pull and Push call `status.pin(button, scope)` before the dispatch.
Every path out of an operation ends in exactly one of `settle`, `dismiss` or a
toast; any other early return leaves a card stuck on "Starting…". Keep `busy`
until the outcome is known. Never show both a card and a toast for one
failure.
Read [Remote activity card
lifecycle](../../../../../../../docs/guides/renderer-remote/card-lifecycle.md#the-click-opens-it-the-outcome-closes-it)
before changing a remote handler, a staleness guard, or Push with no upstream.

## The card accumulates; it does not narrate

**Rule: a row changes exactly once and is never moved or removed.**
Bookkeeping phases (`queued`, `prepare`, `refresh`) earn no row.
Read [Remote activity card
lifecycle](../../../../../../../docs/guides/renderer-remote/card-lifecycle.md#the-card-accumulates-it-does-not-narrate)
before changing `activitySteps`, the narration gate or the output disclosure.

## The card grows; it never takes space back

**Rule: while an operation runs, the card's height only increases.** Reserve
space for anything the card draws for as long as it might need it.
Read [Remote activity card
lifecycle](../../../../../../../docs/guides/renderer-remote/card-lifecycle.md#the-card-grows-it-never-takes-space-back)
before changing step tracks, `meterSlot`, the health line or row labels.

## Dismissal belongs to the user, not to the pointer

**Rule: a pinned card ends only on a user action or when the rail runs out.**
Read [Remote activity dismissal and
placement](../../../../../../../docs/guides/renderer-remote/dismissal-and-placement.md#dismissal-belongs-to-the-user-not-to-the-pointer)
before changing the outside-click listener or the countdown rail.

## One card, four placements

`RemoteActivityCard` renders in the pinned popover, the hover card,
`RemoteActivityToast` and `PushRefsDialog`. Share the card; do not add
variants.
Read [Remote activity dismissal and
placement](../../../../../../../docs/guides/renderer-remote/dismissal-and-placement.md#one-card-four-placements)
before changing where the card renders or what the toast shows.

## Seconds belong in the card, never in the live region

- **The sync chip is `role="status"`. Its label is the phase only** ("Fetching
  updates…"). A live region with a counter re-announces every second.
- **Show everything counted in seconds in the card** (elapsed, "no Git output
  for 2m 04s"). The card is not a live region.
- **The toast sets `aria-live="off"`.** It appears unasked and changes every
  second.

## Only warn about quiet during network phases

**`remoteActivityStatus` treats silence as evidence only in `fetch` and
`push`,** where `--progress` forces Git to emit. Checkout, stash and merge
often print nothing for a long time, so a warning there would fire on every
healthy pull.

## The hover path survives, for the operations a click cannot cover

Operations something else started (sidebar refresh, bulk sync, a second
window) open a transient hover card, gated on the operation's age. A pin
stands the hover path down. Do not use `useHoverIntent` here.
Read [Remote activity hover
path](../../../../../../../docs/guides/renderer-remote/hover-path.md#the-hover-path-survives-for-the-operations-a-click-cannot-cover)
before changing `useRemoteActivityPopover` or the age gate.

## A hover is a place, not a moment — and so is focus

The popover remembers the trigger a hover or focus landed on and re-arms when
the record arrives. Use `:focus-visible`, never `:focus`. A hover-path test
may not press the button first.
Read [Remote activity hover
path](../../../../../../../docs/guides/renderer-remote/hover-path.md#a-hover-is-a-place-not-a-moment--and-so-is-focus)
before changing trigger arming, the Tab handoff, or its jsdom and e2e tests.
