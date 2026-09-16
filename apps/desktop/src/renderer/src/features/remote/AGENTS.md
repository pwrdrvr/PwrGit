# features/remote — AGENTS.md

Live status for a running fetch / pull / push. The main-process half is
`src/main/git/remote-activity.ts` — read its `AGENTS.md` section for what the
record means and why `queued` / `silent` are separate facts.

## The click opens it; the outcome closes it

Pressing Fetch, Pull or Push calls `status.pin(button, scope)` **before the
dispatch**, and the card is up from that moment — no age gate, no hover, and no
wait for main to register the operation. It then outlives the operation: when
the dispatch resolves, `status.settle({status, summary})` turns the same card
into the receipt. A success drains a countdown rail and takes itself away; a
failure stands until dismissed.

That last part is the load-bearing half, and it is why the card takes a
`RemoteActivityView` rather than a `RemoteActivity`. `finish()` deletes the
record and publishes in the same breath, so by the time an outcome exists there
is nothing left to read: `Pin` carries the scope taken at the click, and
`lastSeen` carries the final record so the receipt can still quote Git. A
snapshot, never a reference.

**Every path out of an operation ends in exactly one of three things** —
`settle`, `dismiss` (a modal is taking over: the divergence dialog, the SSH
recovery prompt, the fork prompt), or, for a failure the card could not carry,
a toast. A fourth early return without one of them leaves a card pinned on
"Starting…" until the user clicks it away.

The staleness guards **are** that fourth return, and they deliberately cannot
settle: an operation whose checkout is no longer selected has an outcome that
belongs to a toolbar nobody is looking at. `WorktreeHeader` answers them by
dismissing on `worktree.id`, in an effect of its own because the reset effect
beside it is declared before the hook that owns `dismiss`. And `run` carries
the same `activeWorktreeId` guard `onPull` and `onPush` already had — without
it a fetch started on the checkout you left settles the card of the one you
are on, under the wrong title, and reports itself carried so the toast that
should have caught the failure never fires.

`settle` returns whether a pinned card took the outcome, and `flashError` uses
that: a durable card anchored to the button that was pressed, carrying Git's
own output plus Logs and Copy, is a better report than a corner toast — and
both at once is the same failure said twice. The toast is now the fallback for
a failure with nowhere anchored to go, which is what happens when the user
clicked the card away mid-operation.

## Dismissal belongs to the user, not to the pointer

A hover card is the pointer's: leaving it, or scrolling the surface it
described, is the dismissal. A clicked card is not, so `useViewportTooltip`
grew `setSticky`, which makes `scheduleHide` and the scroll dismissal no-ops.
What ends a pinned card is Escape, the always-present ✕, the Close button on a
failure, a `mousedown` anywhere outside it and outside its own trigger, or the
rail running out.

Two things about that outside-click listener. It is **capture phase**, so a
surface that stops propagation cannot strand the card on screen; and it calls
no `preventDefault`, so the click still lands where it was aimed — dismissing
costs the user nothing but the card. Pressing the trigger again is not
"elsewhere": that button either starts the next operation (and re-pins) or is
inert because one is running, and neither should take the status away.

The rail pauses while the pointer is inside the card and stops outright on a
click or a focus into it — a pointer resting is "still reading", a click is
"leave this alone". `paused` drives both the CSS `animation-play-state` and the
JavaScript timer, which banks its remainder in its effect cleanup, so the bar
and the dismissal always resume from the same place. Under
`prefers-reduced-motion` the blanket `animation: none !important` in app.css
would leave a full rail on a card that then vanished unannounced, so the
popover sets `transform: scaleX()` inline from the seconds clock instead: the
same drain, in four discrete steps.

`settle` starts the receipt **un-held**. A click that landed while the
operation was still running — Copy, or Cancel itself — was not a click on a
countdown, because there was no countdown yet; carried forward it hands the
user a card that never leaves and no timer they could have seen to stop. The
pointer is the other half and is deliberately *not* reset: `within` is where
it is right now, and a card under the pointer still waits.

`REMOTE_ACTIVITY_SETTLED_MS` may be as short as it is *because* of those
pauses, not despite them — that, plus the ✕, is WCAG SC 2.2.1 met three ways.

## One card, three placements

`RemoteActivityCard` is rendered by the pinned popover, by a hover-opened card
from the same hook, and by the elsewhere-toast (`RemoteActivityToast`). They
answer the same question from different places, so they share the card rather
than growing dialects of it; `compact` drops the Git-output block for the
toast, and `onClose` is what draws the ✕ and the Close button — given only
where dismissal is the user's to make.

The split between popover and toast is scope, and it is load-bearing: the toast
shows only operations the toolbar on screen is *not* already reporting. Show
both and a status card covers the graph for the length of every pull you
started yourself. The toast always builds a **live** view for the same reason:
a receipt belongs beside the button that was pressed, and that card is by
definition for a repository the user is not looking at.

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

## The hover path survives, for the operations a click cannot cover

Everything below this line is about the *other* way in, and it still earns its
keep: an operation against this checkout that something else started — the
sidebar's refresh, a bulk sync, a second window. There was no click to pin
from, so the pointer is the only signal there is. That card is transient
(it leaves with the pointer) and never grows a rail, because there is no
settle to report.

**A hover card refreshes itself, and ends with the record.** Its own effect,
and it is the whole reason the card is worth opening: elapsed, the transfer
meter and "no Git output for 2m 04s" exist only in *later* records, so a card
frozen at the instant it opened draws a wedged fetch as a healthy one. The
record going is also its ending, and that is not belt-and-braces — the
pointer's exit rides on `close()`, a prop on a control that stops being a
trigger the moment its operation ends, so an operation that finishes under a
resting pointer takes its own dismissal away with it.

A pinned card stands the whole of it down: `open`, `close`, the arming effect
and that refresh all return early while there is a pin, and the deferred open
checks again when its timer fires. The click has already answered the question
this machinery exists to answer, and re-arming underneath it would leave a
hover primed to reopen a finished operation's card the moment the pinned one
was dismissed.

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
(`REMOTE_ACTIVITY_POPOVER_AFTER_MS`), and that is not a dwell timer.
Measuring from `startedAt` means a hover onto something that has already been
running opens instantly, which is the case the card is for.

**That gate no longer applies to the click**, and the reason it once did is
worth keeping straight. It existed because clicking Pull leaves the pointer
resting on the button, and swapping the glyph for the spinner fires
`mouseenter` under that stationary pointer — so without it every ordinary
one-second pull threw a card over the graph and took it away again. Pinning
answers that case directly: the card is already open when the enter arrives,
and the enter finds it and does nothing. What the gate still suppresses is a
card **nobody asked for** — a bulk sync turning this button busy under a
pointer that came to rest there for its own reasons, once per repository. A
click is an ask; that is not.

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

It reaches past the trigger the record names, because a pinned card hangs off
whichever button was *clicked* — but only as far as that button
(`status.pinnedKind`). The three are adjacent and carry `aria-disabled` rather
than `disabled`, so they stay tabbable while one of them works: claiming Tab
on all three would send a keyboard user on Push backwards, past Push, into a
card hanging off Pull (SC 2.4.3).

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

The jsdom half has one more constraint worth stating plainly, because it is
easy to undo by accident: **a hover-path test may not press the button first.**
Every one of them used to, purely to make a control busy, and a click now pins
a card and stands the hover machinery down. Emitting a record alone is the way
— `running` answers to the record as well as to this header's own dispatch, so
a bare record *is* an operation something else started, which is the case the
hover path is for.

The browser facts live in `e2e/remote-activity.spec.ts`: the pull test, the
same test for Fetch, the Enter-then-Tab-to-Cancel walk, the walked-away test,
and the settled receipt. Playwright's `hover()` cannot re-enter a control the
pointer is already inside — after `pull.click()` it dispatches a bare
`mousemove` and no boundary event at all — which is why none of them lean on
one. The walked-away test carries the explicit `:focus-visible` assertion that
holds the hover path's selector honest, and now asserts the inverse of what it
used to: a clicked card is *not* the pointer's to take away, and only the click
out in the graph ends it.
