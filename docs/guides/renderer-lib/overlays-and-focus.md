# Renderer overlays, Escape and focus traps

This guide covers click-opened overlays, which surface owns Escape and Tab, and how `useFocusTrap` handles scrollers and the opener.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/lib](../../../apps/desktop/src/renderer/src/lib/).

## Click-opened overlays go through `useDismissable` / `useModal`

Hand-rolled keydown effects (four menus, fourteen dialogs) left `.branch-pop`
and the sidebar options menu without keyboard close, and five dialogs without
Escape.

- **A menu**: `useDismissable` + `useMenuNavigation`. With `role="menu"`,
  `useMenuNavigation` is required: the role promises arrows, Home/End and
  typeahead.
- **A dialog**: `useModal` (the two above plus `useFocusTrap`). Give the
  element `role="dialog"`, `aria-modal="true"` and `tabIndex={-1}`.
- **A tablist**: `tablistKeys`, plus a roving tab stop
  (`tabIndex={selected ? 0 : -1}`).

### Escape belongs to exactly one overlay, and focus decides which

`useDismissable` finds the owner **once per keypress**, from one module-level
listener: the registered surface that holds focus. The deepest wins, and a
trigger counts as part of its surface.

Three simpler rules are wrong:

- *Listener order.* All listeners are on `window`, so `stopPropagation` does
  nothing. `stopImmediatePropagation` reaches only later listeners, which is
  backwards for a menu inside a dialog.
- *Open order.* React runs child effects first, so a nested pair mounted in
  one commit registers innermost first.
- *One listener per hook.* Dismissing the owner moves focus. The next listener
  then finds a new owner, so one Escape closed a menu and its dialog.

Focus in an **unregistered** element (the ⌘F repo switcher does not use the
hook) means no overlay claims the key. Otherwise Escape closes the dialog below
the surface the user is dismissing. Only "nowhere in particular" (`<body>`,
null, detached) falls through to the newest overlay.

### Claiming Escape means calling `preventDefault` — and checking it first

- **Claim.** `DiffPane` and `FileInsightsPane` close only
  `if (!event.defaultPrevented)` (see `features/diff/AGENTS.md`). An overlay
  that dismisses without claiming also closes that pane, as ContextMenu did.
  `useDismissable` claims for every caller.
- **Check.** `useDismissable` (click-opened overlays) and `useViewportTooltip`
  (hover cards) keep separate stacks on `window`. Before each checked
  `defaultPrevented`, one Escape closed both a card and the menu below it.

#### Ordering between the two stacks

- `useDismissable`'s listener is on the **capture** phase, so it runs before
  every bubble listener. Why: a deferred check settles ties by listener order,
  and `useDismissable` re-adds its listener each time its stack empties and
  fills. The same gesture then closed the menu or the card at random.
- The deliberate surface (menu, dialog) wins over the hover card.
- When focus is inside a card, `escapeOwner` finds no registered owner and
  claims nothing, so the card's handler gets an unspent key.
- `DiffPane` defers its `defaultPrevented` check by one tick instead. Both
  approaches work. **A synchronous check from a bubble listener does not**; its
  result is random.

### A hover card claims Escape only if the keyboard summoned it

`useViewportTooltip` always dismisses on Escape. It calls `preventDefault` only
when focus is inside the card or the trigger matches `:focus-visible`. A
pointer-opened card does not claim: focus is on the surface the user meant (the
diff pane, a dialog). Taking the key would force a mouse move, which SC 1.4.13
forbids.

Why: the pointer almost always rests on a card in `DiffPane` and
`FileInsightsPane`. Claiming always failed "Escape closes the diff pane" and
"Escape leaves file details" in `e2e/diff.spec.ts`.

- **Use `:focus-visible`, never `:focus`.** Chromium focuses a clicked button
  without making it focus-visible. `WHERE_THE_USER_IS` in `features/remote`
  uses the same fact.
- **jsdom matches `:focus-visible` on any focused element** (verified on
  jsdom 30.1.3). Chromium does not after a click. So a unit test cannot tell a
  clicked trigger from a keyboard one. Reach the claiming branch by focusing
  inside the card, not the trigger.

**The dismissal latches the trigger, and a pin clears it.**

- After a claimed Escape, the trigger stays in `dismissedTargetRef` until
  pointer or focus leaves it. So restoring focus to it cannot reopen the card.
- `setSticky(true)` clears the latch. A click or Enter is a new request, not a
  focus restore.
- A latch left set fails silently: `show` refuses, and the caller cannot see
  it. In `features/remote`, a pin with no card still reports *carried*, so the
  failure that should raise a toast is reported nowhere.

`onPointerWithin` is reported from the card's own root, so the padding ring
counts as inside. `hide()` reports `false`, because no `mouseleave` comes after
the node is gone.

### Tab belongs to exactly one trap, by the same rule

`useFocusTrap` finds one owner per keypress: the trap that holds focus
(deepest wins), else the newest. **A new trap gets this automatically. Do not
add a second keydown handler for Tab.**

Why: `confirmDialog` inside `PruneWorktreesDialog` puts DialogHost's trap over
Prune's. Each trap pulls stray focus back. Without an owner rule, the lower
trap took Tab from the confirm, and two traps fought until focus stuck on an
edge.

A menu portalled out of a trapped dialog (ImageLightbox's copy menu) is the
one case where outside focus is not stray. The trap listens in capture, so it
sees Tab first, and `useMenuNavigation` closes on Tab only while focus is
inside. So for focus inside a `[role="menu"]`, the trap claims the key but
moves focus after the menu's listener runs.

### A scroller can be a Tab stop with no tabindex

Chromium puts an overflowing scroller with nothing focusable into the Tab
order. Its `tabIndex` still reads -1, so no selector finds it. In a nested
pair, only the inner one is a stop. (Measured on Chromium 151 in #307; Electron
44.9.3 now ships Chromium 152.)

- `useFocusTrap` checks layout for these scrollers at the ends of the Tab
  cycle. Without this, Tab skipped them, and a long facts list or Bulk Sync's
  results could not be scrolled from the keyboard.
- Initial focus skips scrollers and goes to a control.
- jsdom does no layout. A test sets `scrollHeight`/`clientHeight` itself (see
  the trap's tests).

### `useFocusTrap` captures the opener during render

Not in an effect. React applies `autoFocus` during commit, *before* passive
effects. An effect therefore recorded the autoFocused field as the opener and
restored nothing on close.
