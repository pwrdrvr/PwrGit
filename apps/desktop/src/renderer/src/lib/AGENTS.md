# renderer/lib — AGENTS.md

Shared renderer primitives. See `apps/desktop/AGENTS.md` for app-wide notes.

## Hover-opened popups go through `useHoverIntent`

Every SHA chip sits in the same fixed column, so a pointer crossing the graph
enters every trigger on its way elsewhere. Opening on raw `onMouseEnter` leaves
a trail of cards (and fires per-row IPC). `hoverIntent.ts` gates the **pointer**
path on dwell *and* evidence the pointer is aiming; focus and click bypass it.

Wire a new hover popup with `hoverIntentHandlers({ intent, show, hide })` rather
than hand-rolling the four handlers — it is the tested routing:

```tsx
const chip = hoverIntentHandlers({ intent: hoverIntent, show, hide });
<span onMouseEnter={(e) => chip.onMouseEnter(e.currentTarget)}
      onMouseLeave={chip.onMouseLeave}
      onFocus={(e) => chip.onFocus(e.currentTarget)}
      onBlur={chip.onBlur} />
```

Read `e.currentTarget` **synchronously** into the call, as above. The open is
deferred, and React nulls `currentTarget` once the handler returns.

Components that render one gate for many rows (`LineageGraph`) own the hook and
pass the `HoverIntent` down; a lone chip may call `useHoverIntent()` itself.
When a popup outlives the hover that opened it (an interactive card the pointer
moves into), tell the gate with `cardClosed()` when it leaves the screen, or its
"user is browsing" warm window expires while the card is still being read.

## Which hover popups are gated

Gate a popup when its trigger **repeats down a column the pointer crosses on
its way elsewhere** (SHA chips, PR chips), or when opening it costs something.
Leave it instant when the trigger is an isolated control the pointer had to aim
at — `RepoRow`'s refresh button, `CopyTarget` inside an already-opened card.
There is no sweep to suppress there, and a delay would only feel sluggish.

Hover work that is expensive rather than visual takes a longer, plainer delay
of its own: `WorktreeRow` prefetches a PR after 750ms and cancels on leave.

## Aiming is two conditions, either of which is enough

The pointer counts as aiming if it has stayed within `HOVER_INTENT_JITTER_PX`
of where it entered the trigger, **or** slowed below
`HOVER_INTENT_SETTLE_PX_PER_MS`. Speed alone would exclude anyone whose hand
does not hold still — a 10px tremor reads as 0.5 px/ms and would never open a
card. A sweep satisfies neither, so the extra path costs no suppression.

## Popups shown on hover must be dismissible

`useViewportTooltip` handles Escape (WCAG 2.1 SC 1.4.13) and returns focus to
the trigger when the user had tabbed into the card. Anything that renders its
own hover surface outside that hook owes the same.

## Click-opened overlays go through `useDismissable` / `useModal`

The same rule, for the surfaces a click opens. Do not hand-roll a keydown
effect: four menus and fourteen dialogs each grew their own, and the result was
that `.branch-pop` and the sidebar options menu could not be closed from the
keyboard at all, and five dialogs had no Escape of any kind.

- **A menu**: `useDismissable` + `useMenuNavigation`. The second is not
  optional if the surface says `role="menu"` — the role promises arrows,
  Home/End and typeahead, and a screen-reader user told "menu" reaches for
  them.
- **A dialog**: `useModal`, which is the two above plus `useFocusTrap`. Give
  the element `role="dialog"`, `aria-modal="true"` and `tabIndex={-1}`.
- **A tablist**: `tablistKeys`, plus a roving tab stop
  (`tabIndex={selected ? 0 : -1}`).

### Escape belongs to exactly one overlay, and focus decides which

`useDismissable` resolves the owner **once per keypress**, from a single
module-level listener, by which registered surface holds focus (deepest wins,
trigger included). Three simpler rules are wrong, and each looks right:

- *Listener order.* Everything listens on `window`, so `stopPropagation` has
  nothing to stop and `stopImmediatePropagation` only reaches listeners added
  later — backwards for a menu opened inside an existing dialog.
- *Open order.* React runs child effects before parent effects, so a nested
  pair mounting in one commit registers innermost-first.
- *One listener per hook instance.* They all fire for the same key, and
  dismissing the owner moves focus, so the next listener computes a different
  owner and dismisses that too — one Escape closing a menu and the dialog
  behind it.

Focus parked in something **unregistered** means nobody claims the key. Not
every floating surface uses the hook (the ⌘F repo switcher does not), and
claiming it there closes the dialog underneath while the user is dismissing the
thing on top of it. Only "nowhere in particular" (`<body>`, null, detached)
falls through to the newest overlay.

### Claiming Escape means calling `preventDefault` — and checking it first

`DiffPane` and `FileInsightsPane` close only `if (!event.defaultPrevented)`
(`features/diff/AGENTS.md` writes this out). An overlay that dismisses without
claiming takes the pane behind it down too — which is what ContextMenu did.
`useDismissable` claims for every caller, so this is handled as long as you use
it.

The rule runs **both ways**, and that half was missing. `useDismissable` and
`useViewportTooltip` own separate stacks — click-opened overlays and hover
cards — and both listen on `window`, so a hover card showing over an open menu
had one Escape dismiss both. Each now returns early on `defaultPrevented`.
A third keydown handler on `window` owes the same on both counts: claim the key
when you spend it, and leave it alone when someone else already has.

Deferring alone is not enough, because it settles ties by **listener order**,
and `useDismissable`'s listener is removed and re-added each time the overlay
stack empties and refills — so the same gesture would close the menu sometimes
and hide the card other times. Its listener is therefore on the **capture**
phase, which runs ahead of every bubble listener however late it was added. A
menu or dialog is something the user opened on purpose and a hover card is not,
so the deliberate surface wins. The card is not cheated out of its own case:
when focus is inside one, `escapeOwner` finds no registered surface holding it
and claims nothing, so the card's handler gets an unspent key.

`DiffPane` solves the same ordering problem the other way, by deferring its
`defaultPrevented` check a tick. Either is fine; what is not fine is a
synchronous check from a bubble listener, which is a coin flip.

### `useFocusTrap` captures the opener during render

Not in an effect. React applies `autoFocus` while committing, which is *before*
passive effects, so a dialog with an autoFocused field — most of them — had
already moved focus inside itself by the time an effect could look. The hook
then recorded that field as the opener and restored nothing on close.

## `useAutoPaging` re-observes on `loading`, never on `error`

`useAutoPaging` fills a tall viewport by rebuilding its IntersectionObserver
every time `loading` clears — the "load more" control does not move enough to
emit a fresh intersection of its own, so without that the fill stops after one
page.

The same edge is what makes the `error` argument load-bearing rather than
cosmetic. A page that FAILS also clears `loading` without advancing the cursor,
so re-observing fired the identical request again, immediately, forever: a
probe reached 200+ dispatches in a few microtask flushes, each spawning a Git
process. A failed page waits for the reader to press the button.

Two rules for callers, then:

- **Pass the real error state.** Passing `null` reintroduces the loop.
- **The control stays rendered.** It is the keyboard affordance, the retry
  after a failure, and the fallback where `IntersectionObserver` is undefined
  (the hook no-ops there rather than paging).

The hook also refuses to request any one cursor twice, so a caller that
returns an unchanged `nextCursor` stalls instead of spinning.

## Remote branches are paged — never list them whole

`repo:refs` returns every **local** branch, but only a six-row
`previewBranches` per remote plus a `branchCount`. It is not the whole
repository, and it must not become that again: on a fetched fork network
(openclaw, 4,470 remote-tracking refs) shipping them all was 1.5 MB of JSON per
call, held in renderer state, and — in the reset and push dialogs — one
`<option>` per ref.

Any surface that browses or picks from more than the preview pulls pages
through `useRemoteBranchSearch` (→ `repo:remoteBranches`), which debounces the
query, filters in the main process, and returns `{ rows, total }`. Two rules
that fall out of that:

- **Say what you truncated.** A page that stops at 50 of 4,466 with no marker
  reads as the whole remote — render `RefsPageFooter` (or the picker's own
  status line) so the count is visible.
- **Filter in main, not in the page.** Filtering only the rows already fetched
  silently hides matches that sort past the first page.

`BranchRefPicker` is the shared control for "pick one ref" (reset-to-remote,
push source). It stays a sized `<select>` — a native listbox already has the
keyboard and screen-reader model — and note that a sized select exposes role
**listbox**, not combobox, which is what Playwright specs must query.

Tags follow the same bounded-IPC rule. `repo:refs` carries only `previewTags`
plus `tagCount`; tag browsers search and page through `repo:tags` via
`useTagSearch`. A tag is never a `BranchRef`: do not feed it to branch switching,
branch pickers, or worktree creation without a separate UI that explicitly
chooses detached HEAD or a newly named branch.
