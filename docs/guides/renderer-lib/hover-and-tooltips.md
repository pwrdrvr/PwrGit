# Renderer hover popups and tooltips

This guide covers hover-intent gating, `hoverTooltip` cards in place of native `title`, and how hover cards stay dismissible and reachable.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/lib](../../../apps/desktop/src/renderer/src/lib/).

## Hover-opened popups go through `useHoverIntent`

`hoverIntentHandlers({ intent, show, hide })` is the tested routing. Read
`e.currentTarget` **synchronously** into the call. The open is deferred, and
React sets `currentTarget` to null after the handler returns.

```tsx
const chip = hoverIntentHandlers({ intent: hoverIntent, show, hide });
<span onMouseEnter={(e) => chip.onMouseEnter(e.currentTarget)}
      onMouseLeave={chip.onMouseLeave}
      onFocus={(e) => chip.onFocus(e.currentTarget)}
      onBlur={chip.onBlur} />
```

- `hoverIntent.ts` gates the **pointer** path on dwell *and* on evidence that
  the pointer is aiming. Focus and click bypass the gate.
- Why: all SHA chips sit in one fixed column. A pointer that crosses the graph
  enters every trigger, so a raw open leaves a trail of cards and fires IPC
  per row.
- A component with one gate for many rows (`LineageGraph`) owns the hook and
  passes the `HoverIntent` down. A lone chip may call `useHoverIntent()`.
- If a card stays open after its hover (an interactive card the pointer moves
  into), call `cardClosed()` when it leaves the screen. Otherwise the gate's
  "user is browsing" warm window expires while the user reads the card.
- **An interactive card passes its tooltip as `card`** to
  `hoverIntentHandlers` (`PrChip`). Leaving then takes the grace path below
  (`hideFrom`/`blurFrom`), and `hide` stays the immediate close for a click.
  Without `card`, leave calls `hide`. `GraphRow` passes `scheduleHide` as
  `hide` instead, because one card serves every row.
- **One lingering card at a time.** Each `PrChip` owns its card, so a card
  waiting out its grace could sit beside the next chip's. Every gated open
  calls the gate's `claimCard`, which closes a card that another trigger left
  waiting. Only callers with `card` register to be closed, and they pass
  their trigger to `cardClosed` so the gate lets go. The commit card must not
  register: it holds a `PrChip`, and opening that chip's card would close the
  commit card around it.

## Which hover popups are gated

- **Gate** a popup when its trigger repeats down a column that the pointer
  crosses (SHA chips, PR chips, author bylines), or when opening it costs
  something.
- **Keep it instant** for an isolated control that the pointer had to aim at:
  `RepoRow`'s refresh button, `CopyTarget` inside an open card. There is no
  sweep to suppress, and a delay only feels slow.
- Expensive (not visual) hover work uses its own longer delay. `WorktreeRow`
  prefetches a PR after 750ms (`PR_HOVER_PREFETCH_DELAY_MS`) and cancels on
  leave.

## Aiming is two conditions, either of which is enough

The pointer is aiming if it stayed within `HOVER_INTENT_JITTER_PX` of its
entry point, **or** slowed below `HOVER_INTENT_SETTLE_PX_PER_MS`. Speed alone
excludes an unsteady hand: a 10px tremor reads as 0.5 px/ms and never opens a
card. A sweep satisfies neither condition.

## A tooltip is `hoverTooltip`, never a native `title`

Use one `useViewportTooltip()` and one `tooltipNode` per component, for any
number of triggers. `hoverTooltip` (from `useViewportTooltip.tsx`) adds no
state:

```tsx
const tip = useViewportTooltip();
<button {...hoverTooltip(tip, "Fetch all remotes")}>…</button>
{tip.tooltipNode}
```

- `hoverTooltip` returns `onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur`
  together. Hand-written copies eventually drop the focus half.
- **Convert a native `title` when you touch its surface.** About 130 were
  converted across sidebar, graph, diff, rail, chrome and settings. A few came
  back: the `<code>` paths in `RepositorySetupSheet` and the copy-actions
  button in `RepoSwitcherOverlay`.

Why not `title` (most important first):

- **Pointer-only.** It never appears on keyboard focus.
- **Not dismissible** (SC 1.4.13). The hook handles Escape.
- **Not a reliable accessible name.** On a `<span>` it is advisory. On a
  control with text, the text wins: `.diff-gutter--blame` announced its line
  number until it got an `aria-label`.
- **Sometimes never renders.** `.repo-mark` (a 12×12 box around an SVG with
  `fill="none"`) showed nothing, while `ForgeChip` in the same row did. The
  cause is unknown. Do not investigate it.
- **Looks different.** The OS draws a dark square box at the pointer's
  bottom-right. Other surfaces draw a light card, so one 320px column shows two
  styles.

### Replacing a `title` that carried the name

- If the `title` was the element's only name, use `aria-label`. Add
  `role="img"` for a meaningful glyph.
- If the element is INSIDE a named control, make it `aria-hidden`. An
  `aria-label` there joins the parent button's name. That made `origin` read
  "origin You can't push to desktop/dugite. Fork it to contribute. default".

### A disabled control still gets a card — say it in both places

Chromium fires `mouseover`, `mouseenter` and `mousemove` on a disabled
`<button>`; only click-type events are suppressed. This was **verified by
probe**, against intuition. So a disabled control keeps its card with the
reason.

- **Also put the reason in `aria-label`.** A disabled button still announces
  its name, and assistive technology reads the name, not the card.
- **Shape: `<visible label, character for character> — unavailable,
  <reason>`**, trailing ellipsis included.
- Why: `aria-label` *replaces* the contents for name computation. A label
  without the visible text breaks SC 2.5.3, voice control, and
  `getByRole("button", { name })`. Four e2e specs failed when the reason
  replaced the label.
- Example: before a profile loads, the sidebar's Add folders button is named
  "Add folders… — unavailable, load or create a profile first". Its card shows
  the plain sentence.
- A disabled `ContextMenu` entry has no card. It shows the reason in its `hint`
  line.

### What is not a tooltip

`grep 'title='` still finds these. Do not change them:

- A `title` prop on a component (`SettingsSection`, `SettingsPanelHead`,
  `ReadError`, `GraphColumn`, `AuxiliaryTitleBar`). It renders as a heading or
  an `aria-label`.
- `<svg><title>` and `<iframe title>`.

A card that repeats text already fully on screen is noise. So two `title`s
were deleted, not converted: `.ssh-trust__link` (`overflow-wrap: anywhere`)
and `.refs-plan__notice small` (wraps). Before you delete one, check for
`text-overflow: ellipsis`. Most repeats are overflow recovery.

For an ellipsised label whose card only repeats it, use
`truncatedTooltip(tip, text)`. It opens only while the text is cut short.
Examples: sidebar repo and branch names, the title bar's repo crumb.

### Testing it

- **Assert the rendered card or the accessible name.** Never restore a `title`
  to make a spec pass.
- Playwright: `await el.hover()`, then `expect(window.getByRole("tooltip"))`.
- vitest: dispatch a bubbling `mouseover` inside `act`, then read
  `[role="tooltip"]` from `document` (`WorktreeRow.test.tsx`,
  `ForgeChip.test.tsx`).
- When each row owns a hook, two cards can be open at once. Dispatch
  `mouseout` between rows, as a real pointer does.
- `renderToStaticMarkup` cannot see a card.
  `expect(markup).not.toContain("Drag to reorder")` passes even for a
  *draggable* row, so that assertion proves nothing.

## Popups shown on hover must be dismissible

`useViewportTooltip` handles Escape (WCAG 2.1 SC 1.4.13). It returns focus to
the trigger if the user tabbed into the card. **A hover surface outside that
hook must do the same.**

Any scroll dismisses an interactive card, **unless the user reached it** by
pointer or by focus. A keyboard user sets no pointer flag, so without the focus
condition an unrelated scroll (the graph changing `scrollTop` as commits
stream in) removed the card with focus inside it. Tab moves into cards from
`GraphRow` and `WorktreeHeader`.

### A card belongs to a connected trigger

`show` refuses a trigger that is not in the document. An open card closes,
pinned or not, when its trigger leaves. **Do not fix a misplaced card in the
caller; the hook owns this.**

Why: a refresh can unmount a graph row under the pointer, and React sends no
`mouseleave` for a removed node. A gated open (`hoverIntentHandlers`) can call
`show` after the dwell on a row that is gone. A detached rect is all zeros, so
the card appeared at the viewport origin, over the traffic lights, with no way
to dismiss it.

### Interactive cards must be reachable

A card with controls in it (`interactive: true`) has to survive the trip from
its trigger to those controls. The Changes rail's "Why?" card failed all three
of these checks, so none of its buttons could be pressed:

- **The card takes the pointer.** `.viewport-tooltip` is
  `pointer-events: none`. A card that keeps that class needs a two-class rule
  that sets `auto`. `styles/interactive-card-pointer-events.test.ts` checks
  every interactive card.
- **Leaving the trigger waits.** `hideFrom` and `blurFrom` keep the card when
  the pointer or focus moves into it, and otherwise give it the 400ms grace
  period. Plain tooltips still close at once.
- **The gap is bridged.** A trigger-anchored interactive card draws a
  transparent `[data-tooltip-bridge]` strip across the gap to its trigger
  (PwrAgnt's messaging-status popover uses padding for the same thing).
- **The bridge ends at the trigger's edge, never inside it.** An overlap
  covers the trigger, so a click there lands on the card. It also makes a
  trigger that hides on leave flicker under a resting pointer.

Use `pinnableTooltip` for a trigger whose only job is to open the card ("Why?",
the hook receipts): a click or Enter pins it until Escape, a press outside, or
a scroll that moves the trigger. A pinned card is a click-opened overlay, so it
registers with `useDismissable` and claims Escape.
Design: turn 6 of `design/Git Discovery - UX Review.dc.html`.

### Nested triggers restore, they don't just hide

A row has a card, and a path inside it has another. React fires no
`mouseenter` on an ancestor the pointer never left. So `hoverTooltip` leaves
through `hideFrom`, not `hide`, which shows the outer card again. A plain
`hide()` leaves the pointer on a trigger that shows nothing.
