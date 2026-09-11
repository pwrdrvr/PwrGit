# features/remote — AGENTS.md

Live status for a running fetch / pull / push. The main-process half is
`src/main/git/remote-activity.ts` — read its `AGENTS.md` section for what the
record means and why `queued` / `silent` are separate facts.

## One card, two placements

`RemoteActivityCard` is rendered by the toolbar popover
(`useRemoteActivityPopover`) and by the elsewhere-toast
(`RemoteActivityToast`). They answer the same question from different places,
so they share the card rather than growing two dialects of it; `compact` drops
the Git-output block for the toast and changes nothing else.

The split between them is scope, and it is load-bearing: the toast shows only
operations the toolbar on screen is *not* already reporting. Show both and a
status card covers the graph for the length of every pull you started yourself.

## Seconds belong in the card, never in the live region

The sync chip is `role="status"`. Its label is the phase alone — "Fetching
updates…" — because a live region carrying a counter re-announces itself every
second, which is unusable with a screen reader on.

Everything counted in seconds (elapsed, "no Git output for 2m 04s") lives in
the card, which is not a live region. The toast sets `aria-live="off"` for the
same reason: it appears unasked and then changes every second, so it is a place
to look, not an announcement.

## Only warn about quiet during network phases

`remoteActivityStatus` treats silence as evidence only in `fetch` and `push`,
where `--progress` obliges Git to emit. Checkout, stash and merge routinely
print nothing for a long time; warning there would fire on every healthy pull
and the warning would stop meaning anything.

## The popover opens on hover with no dwell gate

`lib/AGENTS.md` reserves `useHoverIntent` for triggers that repeat down a
column the pointer crosses on its way elsewhere. These triggers are a single
button and the chip beside it, both of which the user had to aim at, and they
only become triggers while an operation is running. There is no sweep to
suppress, and a delay would make the answer to "what is it doing?" feel
withheld.

It is an *interactive* `useViewportTooltip` because the card carries Cancel —
the pointer has to be able to travel into it, and Escape has to return focus to
the trigger.

What it DOES gate on is the operation's own age
(`REMOTE_ACTIVITY_POPOVER_AFTER_MS`), and that is not a dwell timer. Clicking
Pull leaves the pointer resting on the button, and swapping the glyph for the
spinner fires `mouseenter` under that stationary pointer — so without the gate
every ordinary one-second pull threw a card over the graph and took it away
again. Measuring from `startedAt` means a hover onto something that has already
been running opens instantly, which is the case the card is for.
