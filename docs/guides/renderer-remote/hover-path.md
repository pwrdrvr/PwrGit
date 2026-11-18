# Remote activity hover path

This guide covers the hover and focus path that opens the remote activity card for operations a click did not start, and how to test it.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/features/remote](../../../apps/desktop/src/renderer/src/features/remote/).

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
- **No `useHoverIntent`.** [lib/AGENTS.md](../../../apps/desktop/src/renderer/src/lib/AGENTS.md) reserves it
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

[e2e/remote-activity.spec.ts](../../../apps/desktop/e2e/remote-activity.spec.ts)
holds the browser facts: the pull test ("a pull that gets no answer…"), the
Fetch test ("a wedged fetch opens its card from the click…"), the
Enter-then-Tab-to-Cancel walk, the walked-away test, and the settled receipt.

- Playwright's `hover()` cannot re-enter a control the pointer is inside;
  after `pull.click()` it sends a bare `mousemove`. No test depends on it.
- The walked-away test has the explicit `:focus-visible` assertion. It also
  asserts that the pointer cannot take a clicked card away; only a click in
  the graph ends it.
