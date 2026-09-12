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

## A hover is a place, not a moment

That same stationary-pointer `mouseenter` is the ONLY enter the button will
ever see, and it fires while the button is busy from the renderer's own
`busy` state — one or more renders before main reports the operation and
`activity` stops being `null`. Which side of the record the enter lands on is a
race nobody can see or influence, and losing it used to be permanent: the
pointer is already inside the button, so no further enter is coming and the
card never opened no matter how long the user waited. The one way out was to
move the pointer off the button and back on — for the operation the card exists
for, a wedged fetch, that is the worst possible time to ask.

So the trigger handlers go on from the **first busy render**, not from the
record's arrival (`running === kind` in `WorktreeHeader`, not `carriesCard`),
the popover **remembers the trigger** a hover landed on even with nothing to
report, and it re-arms when the record arrives. An enter that lands anywhere in
the busy period is now kept until there is something to answer it with.

What this does NOT do is invent a hover that never happened, and Fetch is where
that shows: its glyph does not swap (the arrow spins in place), so a click
leaves the pointer on a button that dispatches no boundary event at all, and
the `focusin` the click does fire lands on mousedown — before `running` is set
and before any handler is listening. Resting on a wedged *fetch* still shows
nothing until the pointer leaves the button and returns. Closing that means
asking the DOM where the pointer is (`:hover`) rather than waiting to be told,
which jsdom cannot answer — so it needs an e2e, not a unit test.

Three things keep that from becoming a card nobody asked for.

The re-arm is keyed on the operation's **id**, not on the record — one arrives
every half-second, and re-arming per update would restart the age gate's timer
forever. A wait already counting down for *that same* operation is left alone;
one left over from a finished operation is not, or an operation that replaced
it inside the gate would be armed by nothing at all and its predecessor's timer
would fire into an id check that discards it.

The popover watches the trigger leave *for itself*, with listeners on the
element rather than the `close()` prop: that prop rides on a control which
stops being a trigger the moment its operation ends, so a pointer that wanders
off after that is never recorded as having left — and the stale trigger would
open some LATER operation's card beside a pointer nowhere near it.
(`useViewportTooltip` releases an Escape-dismissed trigger the same way.) Both
exits matter and neither covers for the other: React derives its `mouseleave`
prop from `mouseout`, so a unit test dispatching one does not exercise the
other.

And the widening is in **time only, never in scope**. `running` also answers to
the header's own `busy`, so a locally dispatched fetch can be what makes a
button busy while the live record for that checkout is a pull started
elsewhere. `couldCarryCard` keeps the record's kind matched to the button once
there is a record — a card naming a Pull must never hang off Fetch — while
still letting the trigger listen through the gap before one exists.

`e2e/remote-activity.spec.ts` covers this. Playwright's `hover()` cannot stand
in for the fix: after `pull.click()` the pointer is already inside the button,
so the hover dispatches a bare `mousemove` and no boundary event at all.
