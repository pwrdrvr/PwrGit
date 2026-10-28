# features/remote — AGENTS.md

This feature shows live status for a running fetch, pull or push. The
main-process half is `src/main/git/remote-activity.ts`. Its record, and why
`queued` and `silent` are separate facts, are in
[main/git/AGENTS.md](../../../../main/git/AGENTS.md) ("Every long-running
remote command registers an activity").

## The click opens it; the outcome closes it

- **Every path out of an operation ends in exactly one of: `settle`,
  `dismiss` (a modal takes over: divergence dialog, SSH recovery prompt, fork
  prompt, publish question), or a toast (a failure the card could not
  carry).** Any other early return leaves a card pinned on "Starting…" until
  the user clicks it away.
- **Fetch, Pull and Push call `status.pin(button, scope)` before the
  dispatch.** The card shows from that moment: no age gate, no hover, no wait
  for main to register the operation.
- When the dispatch resolves, `status.settle({status, summary})` turns the
  same card into the receipt. A success drains a countdown rail and removes
  itself. A failure stays until dismissed.
- The card takes a `RemoteActivityView`, not a `RemoteActivity`. `finish()`
  deletes the record and publishes in the same step, so no record exists when
  the outcome arrives. `Pin` carries the scope taken at the click. `lastSeen`
  carries the final record, so the receipt can quote Git. Both are snapshots,
  never references.
- **Keep `busy` until the outcome is known**, including the local inspects
  that decide if a dialog takes over (divergence, SSH recovery). Otherwise the
  user can start an operation whose card the arriving dialog then dismisses.

### Staleness guards

The staleness guards return early and intentionally cannot settle. The
outcome belongs to a checkout that is no longer selected.

- `WorktreeHeader` dismisses on `worktree.id`, in its own effect. The reset
  effect beside it is declared before the hook that owns `dismiss`.
- `run` has the same `activeWorktreeId` guard as `onPull` and `onPush`.
  Without it, a fetch on a checkout you left settles the current checkout's
  card, under the wrong title. It also reports the outcome as carried, so the
  fallback toast never fires.
- All three also check one `remoteOperation` count, incremented by every
  start and every switch. `activeWorktreeId` reads the same again when the
  user returns, so without the count an outcome from the earlier visit lands
  on a later operation.

### Card or toast

`settle` returns whether a pinned card took the outcome; `flashError` uses
this. Do not show both a card and a toast for one failure. The anchored card
is the better report: it carries Git's output plus Logs and Copy. The toast is
the fallback when the user clicked the card away during the operation.

### Push with no upstream

Push on a branch with no upstream is the one click that pins **nothing**.

- It first asks `PublishBranchDialog` which remote to use. A plain push only
  gets Git's refusal and its `--set-upstream` advice for a terminal.
- The card pins on Publish, off the Push button that asked.
- A failure to load the remotes is a toast, never a `settle`. Any card still
  up belongs to an earlier operation.
- The remotes come from `repo:remotes` (one `git remote -v`), not
  `repo:refs`, which walks every ref while the button shows nothing.
- The header reads "no upstream" from the live snapshot, or the indexed row
  until a snapshot arrives. If both were stale, Git returns `no_upstream` and
  the header asks the same question. That is a `dismiss`, not a failure.

## The card accumulates; it does not narrate

**Rule: a row changes exactly once and is never moved or removed. Nothing is
wiped, so nothing needs re-reading.**

Why: phase transitions call `publish(true)` and bypass the 400&nbsp;ms
throttle. A card that rewrote its status line, command and output per phase
redrew five times in a 620&nbsp;ms pull (`prepare → fetch → fast_forward →
reapply → refresh`). That is unreadable, and most operations last under one
second.

- `activitySteps` turns the ordered, deduplicated phases of an operation into
  one row each.
- When a row's work ends, its label moves from present to past tense and its
  marker changes. That is its only change.
- The receipt is the same list with every marker changed.
  `RemoteActivityOutcome` carries `steps`, because `finish()` deleted the
  records the phases were observed on.
- **Bookkeeping earns no row.** `queued` waits on another operation's lock.
  `prepare` is a `git status` that main emits whether or not there is
  anything to stash. `refresh` is PwrGit's own work after Git. Drop these
  phases; do not show then remove them, because a removed row is a layout
  shift. While the operation is in one of them, every real step reads `done`
  (during `prepare`, the fetch above it has finished).
- **A phase Git re-enters is still one row.** A pull pops its stash in two
  places; that is one piece of work.
- **Below `REMOTE_ACTIVITY_NARRATE_AFTER_MS` there is no narration.** The card
  shows one stable line, then its receipt. The steps are still recorded, so
  the receipt is complete.
  - The gate controls what the card says, not whether it opens. The card
    still opens on the click.
  - **The gate covers the whole card, not the step list.** Gating only the
    list let the card fall back to `remoteActivityStatus`, which is the same
    per-phase narration.
  - Below the threshold, `startingView` is the view from the click until
    main's first output: one line, no meter, no command. It reads the record
    only for the id and `canceling` (so Cancel shows as soon as there is
    something to stop) and for the output tail (inside a collapsed
    disclosure, so it cannot move anything).
- **Git's output and the command line are collapsed while the operation looks
  healthy.**
  - The output is `\r`-rewritten progress. Live, it grew to its 108&nbsp;px
    cap while its last line flickered. It was the largest source of churn.
  - `setCommand` fires per Git invocation (about eight per pull), and 160
    monospace characters wrap differently each time.
  - The disclosure opens itself when it is the finding: a quiet warning, a
    failure, or a cancel. Command and last output are the two facts that
    diagnose a wedged transfer, so they stay together.
  - The open state is React-controlled. The popover re-renders every second,
    and an uncontrolled `<details>` would close under the user.

## The card grows; it never takes space back

**Rule: reserve space for anything the card draws for as long as it might
need it. While an operation runs, the card's height only increases.** An
element that appears and disappears moves the evidence block and buttons
below it twice.

- **The PHASE decides if a step has a progress track** (`stepHasMeter`), not
  whether Git has sent a percentage. Git reports only in the middle of a
  phase, and `setPhase` clears `progress`.
  - A `fetch` or `push` row has a track from the moment it is written. A
    `fast_forward` row never has one.
  - `Track` renders the reserved, empty case as presentational, not as a
    `progressbar` with an invented value. Assistive technology must hear
    "running, progress unknown", not "0%".
  - A finished network step reads 100%, in the success colour.
- **The fallback meter keeps its slot for the life of the operation**
  (`meterSlot`). The meter is the toast's standard presentation. The label
  line holds its height when empty, in CSS.
  - `meterSlot` is a field on the view, not derived by the card. The quiet
    card before the narration threshold must NOT reserve it. An empty block
    there would make that card taller than the step list that replaces it,
    so the transition would shrink the card.
- **The health line stays after it first has something to say.** If a quiet
  fetch resumes, update the line in place; do not remove it.
- **The Git-output disclosure stays on the receipt.** If a successful fetch
  has no output, show "Git produced no output." Removing the block moves the
  buttons up as the user reads the outcome.

Permitted movement is growth only: rows are **appended**, the disclosure
**opens** on a finding, and a failure headline appears above the list.

### Row labels

Rows carry bare labels. Counts (*"Fast-forwarded · 12 commits"*) need wider
results from main:

- `remote:fetch` returns only `{ remotes }` (the remotes it asked).
- `remote:push` returns `null`.
- `remote:pull` returns three booleans (`PullOutcome`).
- `pullFastForward` in `src/main/git/git-service.ts` reads the original HEAD
  but discards the commit range.

This is a smaller form of design card 3a's deferred protocol change.

### Where the steps come from

`liveActivityView` takes the steps as an argument. A record shows only the
current phase; the history belongs to the component that watched. The toast
passes no steps, so it gets the status line and the shared meter.

## Dismissal belongs to the user, not to the pointer

**Rule: a pinned card ends only on a user action or when the rail runs out.**

`setSticky` (see [lib/AGENTS.md](../../lib/AGENTS.md)) makes
`useViewportTooltip`'s `scheduleHide` and scroll dismissal no-ops. A pinned
card ends on:

- Escape, or the always-present ✕;
- the Close button on a failure;
- a `mousedown` outside the card and outside its trigger;
- the rail running out.

The outside-click listener:

- uses the **capture phase**, so a surface that stops propagation cannot
  strand the card;
- does not call `preventDefault`, so the click still lands where it was
  aimed;
- ignores the trigger. That button either starts the next operation (and
  re-pins) or is inert while one runs.

### The rail

- It pauses while the pointer is inside the card ("still reading"). It stops
  completely on a click or a focus into the card ("leave this alone").
- `paused` drives the CSS `animation-play-state` and the JavaScript timer. The
  timer saves its remainder in its effect cleanup, so both resume from the
  same point.
- Under `prefers-reduced-motion`, app.css applies `animation: none
  !important`, which would show a full rail on a card that then vanishes. So
  the popover sets `transform: scaleX()` inline from the seconds clock: the
  same drain in four steps.
- `settle` starts the receipt **un-held**. A click during the operation (Copy,
  Cancel) happened before any countdown existed. Carried forward, it would
  make the card permanent. The pointer state (`within`) is intentionally not
  reset: a card under the pointer still waits.
- `REMOTE_ACTIVITY_SETTLED_MS` can be short because of these pauses. The
  pauses plus the ✕ meet WCAG SC 2.2.1 in three ways.

## One card, four placements

`RemoteActivityCard` renders in the pinned popover, a hover-opened card from
the same hook, the elsewhere-toast (`RemoteActivityToast`), and
`PushRefsDialog`. Share the card; do not add variants.

- `compact` removes the Git-output block for the toast.
- `onClose` draws the ✕ and the Close button. Pass it only where dismissal is
  the user's decision.

### `PushRefsDialog`

The dialog is the exception to "a modal takes the card away", because it
starts the operation.

- `remote:planPushRefs` and `remote:pushRefs` are wrapped in `tracked()`
  (see main/git/AGENTS.md). Before that, a wedged SSH agent showed only a
  "Pushing…" caption.
- The dialog draws the card itself. `.toast-host` is z-index 90, under the
  backdrop at 110, so the toast would be dimmed and unclickable.
- It shows the live view only, with no `settle`. Its per-destination results
  table is the receipt.

### Popover or toast

- **The toast shows only operations that the toolbar on screen does not
  report.** Otherwise a status card covers the graph for every pull the user
  started.
- The toast always builds a **live** view. A receipt belongs beside the
  pressed button, and the toast is for another repository.

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

The rest of this file covers operations on this checkout that something else
started: the sidebar's refresh, a bulk sync, a second window. With no click,
the pointer is the only signal. The hover card is transient and never shows a
rail.

- **A hover card refreshes itself.** Elapsed, the meter and the quiet warning
  exist only in later records, so a frozen card shows a wedged fetch as
  healthy.
- **The record going away ends the card.** The pointer's exit uses `close()`,
  a prop on a control that stops being a trigger when the operation ends.
- **A pin stands the hover path down.** `open`, `close`, the arming effect and
  the refresh return early while there is a pin. The deferred open checks
  again when its timer fires. Otherwise a hover could reopen a finished
  operation's card when the pin is dismissed.
- **No `useHoverIntent`.** [lib/AGENTS.md](../../lib/AGENTS.md) reserves it
  for triggers repeated down a column the pointer crosses. These triggers are
  one button and its chip. The user must aim at them, and they are triggers
  only while an operation runs.
- It is an *interactive* `useViewportTooltip`, because the card carries
  Cancel. The pointer must be able to enter it, and Escape must return focus
  to the trigger.

### The age gate

- The hover path gates on the operation's age
  (`REMOTE_ACTIVITY_POPOVER_AFTER_MS`), measured from `startedAt`. It is not a
  dwell timer: a hover onto a long-running operation opens instantly.
- **The age gate does not apply to the click.** The spinner replacing the
  Pull glyph fires `mouseenter` under the resting pointer. A pinned card is
  already open, so that enter does nothing.
- The gate still suppresses a card **nobody asked for**: a bulk sync that
  makes this button busy under a resting pointer, once per repository.

## A hover is a place, not a moment — and so is focus

### The race

The resting-pointer `mouseenter` is the ONLY enter the button gets. It fires
when the renderer's own `busy` is set, one or more renders before `activity`
stops being `null`. If it landed before the record, the card never opened
until the user moved the pointer off and back.

- The trigger handlers start on the **first busy render**: `running === kind`
  in `WorktreeHeader`, not `carriesCard`.
- The popover **remembers the trigger** a hover landed on, even with nothing
  to report, and re-arms when the record arrives.

### No trigger at all: ask the DOM

Fetch's arrow spins in place, so its click fires no boundary event. The
keyboard `focusin` fires on mousedown, before `running` is set. So when the
record arrives and **no trigger is rested on**:

- the popover matches `WHERE_THE_USER_IS` (exported from
  `useRemoteActivityPopover.tsx`) against refs to the busy `.wt-btn` and the
  `.sync-chip--progress` beside it;
- it hands a match to `restOn`, not to `arm`. If the pointer then leaves, the
  element's listeners cancel everything.

### `:focus-visible`, never `:focus`

Chromium focuses a button on click but does not make it focus-visible. So the
keyboard half cannot reopen a card for a pointer that moved away. The
"walked away" e2e asserts this browser fact.

### Tab hands off into the card

- Tab from the trigger moves focus into the card (`focusFirst`, swallowing
  the key), as `GraphRow` does for its commit context card. Without it, Tab
  blurs the trigger and closes the card, so only a mouse could press Cancel.
- The handoff follows the *clicked* button (`status.pinnedKind`), not only
  the trigger the record names.
- The three buttons use `aria-disabled`, not `disabled`, so they stay
  tabbable. If Tab were claimed on all three, a keyboard user on Push would
  jump backwards into a card on Pull (SC 2.4.3).

### Three safeguards against a card nobody asked for

1. **Re-arm on the operation's id, not on the record.** A record arrives every
   half-second, so re-arming per record restarts the age gate forever. Keep a
   wait for the same operation. Clear a wait from a finished operation;
   otherwise its timer fires into an id check that discards it, and the new
   operation is never armed.
2. **The popover watches the trigger leave itself**, with listeners on the
   element, not through `close()`. After the operation ends, that prop is
   gone, so a stale trigger would open a later card far from the pointer.
   `useViewportTooltip` releases an Escape-dismissed trigger the same way.
   React derives `mouseleave` from `mouseout`, so a unit test that dispatches
   one does not exercise the other.
3. **Pointer location and its wait are ONE record.** `Resting` holds the
   trigger, its release and the wait. `restOn` and `forgetTrigger` are the
   only writers. Releasing the trigger removes the wait. `arm` refuses any
   trigger but the current one. Earlier bugs (a wait outliving its operation,
   then its trigger) came from a second cell that tracked part of this state.

### Widened in time, never in scope

- `running` also follows the header's own `busy`. So a local fetch can make a
  button busy while the record is a pull started elsewhere.
- `couldCarryCard` matches the record's kind to the button once a record
  exists. A Pull card must never hang off Fetch. Before a record exists, the
  trigger still listens.

### Testing in jsdom

- jsdom sets `:hover` only on a dispatched `mouseover`, which React turns into
  the `onMouseEnter` these tests must not send.
- jsdom matches `:focus-visible` for any focused element; Chromium does not.
- jsdom clears hover on `mouseout`, not `mouseleave`, so a simulated exit
  needs both.
- So `features/graph/WorktreeHeader.test.tsx` answers `WHERE_THE_USER_IS`
  directly for one element. This covers the ref wiring, the age gate and the
  Tab handoff, but not which selector half a browser would match.
- **A hover-path test may not press the button first.** A click pins a card
  and stands the hover path down. Emit a record alone: `running` follows the
  record, so a bare record is an operation something else started.

### Testing in the browser

[e2e/remote-activity.spec.ts](../../../../../e2e/remote-activity.spec.ts)
holds the browser facts: the pull test ("a pull that gets no answer…"), the
Fetch test ("a wedged fetch opens its card from the click…"), the
Enter-then-Tab-to-Cancel walk, the walked-away test, and the settled receipt.

- Playwright's `hover()` cannot re-enter a control the pointer is inside;
  after `pull.click()` it sends a bare `mousemove`. No test depends on it.
- The walked-away test has the explicit `:focus-visible` assertion. It also
  asserts that the pointer cannot take a clicked card away; only a click in
  the graph ends it.
