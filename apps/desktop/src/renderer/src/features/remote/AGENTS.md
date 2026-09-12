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

## A hover is a place, not a moment — and so is focus

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

None of that invents a hover that never happened, and Fetch is where that
shows: its glyph does not swap (the arrow spins in place), so a click leaves
the pointer on a button that dispatches no boundary event at all. The keyboard
fails the same way from the other side — the `focusin` a click or Enter fires
lands on mousedown, before `running` is set and before any handler is
listening, and no second focus event follows. There is nothing to remember
because nothing was ever reported.

So when the record arrives with **no trigger rested on at all**, the popover
asks the DOM where the user is instead of waiting to be told —
`WHERE_THE_USER_IS`, exported from that file, against refs to the controls that
can carry the card (the busy `.wt-btn` and the `.sync-chip--progress` beside
it). What it finds it hands to `restOn`, not to `arm` directly, so a pointer
that does then move away calls the whole thing off through the element's own
listeners exactly as if it had arrived by event.

**`:focus-visible`, never `:focus`.** Chromium focuses a button on click
without making it focus-visible, so the keyboard half cannot resurrect a card
for a pointer that has walked away. That is a browser fact the code leans on,
so it is asserted directly rather than assumed, in the "walked away" e2e.

**Tab hands off into the card.** The pointer reaches Cancel by moving into the
card; the keyboard needs the handoff `GraphRow` already makes into its commit
context card (`focusFirst`, swallowing the key). Without it Tab lands on Pull,
blurs the trigger and takes the card with it — so opening the card for the
keyboard without this would show a Cancel button only a mouse could press.

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

**Where the pointer is and what it has earned are ONE record.** `Resting`
holds the trigger, its release, and the wait counting down on it, because
every bug this has had was two halves of that fact updated by different code
paths — a wait outliving the operation it was armed for, then a wait outliving
the trigger it was armed from, still firing a card at a pointer that had gone.
`restOn` and `forgetTrigger` are the only writers, arming lives on the record
so letting the trigger go takes the wait with it, and `arm` refuses to arm from
anything but the trigger currently rested on. Keep it that way: a second cell
tracking part of this is how each of those bugs started.

And the widening is in **time only, never in scope**. `running` also answers to
the header's own `busy`, so a locally dispatched fetch can be what makes a
button busy while the live record for that checkout is a pull started
elsewhere. `couldCarryCard` keeps the record's kind matched to the button once
there is a record — a card naming a Pull must never hang off Fetch — while
still letting the trigger listen through the gap before one exists.

Testing splits along what jsdom can say. It does track `:hover` — but only as
bookkeeping on a dispatched `mouseover`, and dispatching one is exactly what
these tests must not do, since React turns it into the `onMouseEnter` whose
absence is the subject. (It also answers `:focus-visible` for anything merely
focused, which Chromium does not, and it clears hover on `mouseout` rather than
on `mouseleave` — so a simulated exit needs both.) `WorktreeHeader.test.tsx`
therefore answers `WHERE_THE_USER_IS` directly for one element: enough for the
wiring (which controls carry the ref), the age gate and the Tab handoff, and
deliberately blind to which half of that query a real browser would have set.

The browser facts live in `e2e/remote-activity.spec.ts`: the pull test, the
same test for Fetch *without* its `hover()`, the Enter-then-Tab-to-Cancel walk,
and the walked-away guard. Playwright's `hover()` cannot stand in for any of
it: after `pull.click()` the pointer is already inside the button, so the hover
dispatches a bare `mousemove` and no boundary event at all. One caveat on the
walked-away guard — the record lands inside the click (~30ms, faster than a
pointer can leave), so the card is armed while the pointer is still there and
`onMouseLeave` is what cancels it. Its explicit `:focus-visible` assertion is
what holds the selector honest.
