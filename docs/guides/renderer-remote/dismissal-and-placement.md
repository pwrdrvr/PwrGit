# Remote activity card dismissal and placement

This guide covers how a pinned remote activity card is dismissed, how its countdown rail behaves, and where the shared card renders.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/features/remote](../../../apps/desktop/src/renderer/src/features/remote/).

## Dismissal belongs to the user, not to the pointer

**Rule: a pinned card ends only on a user action or when the rail runs out.**

`setSticky` (see [lib/AGENTS.md](../../../apps/desktop/src/renderer/src/lib/AGENTS.md)) makes
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
