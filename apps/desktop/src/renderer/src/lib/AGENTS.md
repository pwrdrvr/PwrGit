# renderer/lib — AGENTS.md

Shared renderer primitives. See `apps/desktop/AGENTS.md` for app-wide notes.

Rules that always apply here:

- **Open a hover popup through `hoverIntentHandlers`**, not raw `onMouseEnter`.
- **Show a tooltip with `hoverTooltip(tip, content)`.** Never add a native
  `title`.
- **Close a click-opened overlay with `useDismissable` / `useModal`.** Never
  hand-roll a keydown effect.
- **A `window` keydown handler calls `preventDefault` when it spends a key,
  and skips a key that is `defaultPrevented`.**
- **Pass `subject` on every toast about a repository.**
- **Never list remote branches or tags whole.** Page them through main.

## Hover-opened popups go through `useHoverIntent`

`hoverIntentHandlers({ intent, show, hide })` is the tested routing. Read
`e.currentTarget` **synchronously** into the call; React nulls it after the
handler returns. An interactive card passes its tooltip as `card`.
Read [Hover popups and
tooltips](../../../../../../docs/guides/renderer-lib/hover-and-tooltips.md#hover-opened-popups-go-through-usehoverintent)
before wiring a hover trigger or an interactive card.

## Which hover popups are gated

Gate a popup whose trigger repeats down a column the pointer crosses, or that
costs something to open. Keep an isolated control instant.
Read [Hover popups and
tooltips](../../../../../../docs/guides/renderer-lib/hover-and-tooltips.md#which-hover-popups-are-gated)
before choosing a delay.

## Aiming is two conditions, either of which is enough

The pointer aims if it stayed within `HOVER_INTENT_JITTER_PX` **or** slowed
below `HOVER_INTENT_SETTLE_PX_PER_MS`. Speed alone excludes an unsteady hand.
Read [Hover popups and
tooltips](../../../../../../docs/guides/renderer-lib/hover-and-tooltips.md#aiming-is-two-conditions-either-of-which-is-enough)
before changing `hoverIntent.ts`.

## A tooltip is `hoverTooltip`, never a native `title`

Use one `useViewportTooltip()` and one `tooltipNode` per component. Convert
a native `title` when you touch its surface. A disabled control keeps its card
and also puts the reason in `aria-label`.
Read [Hover popups and
tooltips](../../../../../../docs/guides/renderer-lib/hover-and-tooltips.md#a-tooltip-is-hovertooltip-never-a-native-title)
before adding, converting, deleting or testing a tooltip.

## Popups shown on hover must be dismissible

`useViewportTooltip` handles Escape. A hover surface outside that hook must
do the same. The hook owns connected-trigger checks; do not fix a misplaced
card in the caller.
Read [Hover popups and
tooltips](../../../../../../docs/guides/renderer-lib/hover-and-tooltips.md#popups-shown-on-hover-must-be-dismissible)
before building an interactive, pinnable or nested hover card.

## Click-opened overlays go through `useDismissable` / `useModal`

A menu uses `useDismissable` + `useMenuNavigation`; a dialog uses
`useModal`. Focus decides which overlay owns Escape and Tab. Do not add a
second keydown handler for Tab.
Read [Overlays, Escape and focus
traps](../../../../../../docs/guides/renderer-lib/overlays-and-focus.md#click-opened-overlays-go-through-usedismissable--usemodal)
before building a menu, dialog, tablist or focus trap, or handling Escape.

## `useAutoPaging` re-observes on `loading`, never on `error`

- **Pass the real error state.** `null` brings back a request loop.
- **Keep the "load more" control rendered.**

Read [Paging, forge hosts, toasts and
errors](../../../../../../docs/guides/renderer-lib/paging-forge-toasts-errors.md#useautopaging-re-observes-on-loading-never-on-error)
before changing `useAutoPaging` or a caller.

## Remote branches are paged — never list them whole

`repo:refs` carries only a preview per remote. Search past it with
`useRemoteBranchSearch`, filter in main, and say what you truncated. A tag is
never a `BranchRef`.
Read [Paging, forge hosts, toasts and
errors](../../../../../../docs/guides/renderer-lib/paging-forge-toasts-errors.md#remote-branches-are-paged--never-list-them-whole)
before listing, picking or acting on remote branches or tags.

## Forge host classification comes from main, never from the hostname

**Do not classify a remote without the host map** (`useForgeHostMap`).
Read [Paging, forge hosts, toasts and
errors](../../../../../../docs/guides/renderer-lib/paging-forge-toasts-errors.md#forge-host-classification-comes-from-main-never-from-the-hostname)
before classifying a remote or calling clone/fork commands.

## A vendor's logo is not an icon — it does not take `currentColor`

Use the vendor's files as `<img>` in a square `object-fit: contain` box.
Never redraw or recolor a mark.
Read [Paging, forge hosts, toasts and
errors](../../../../../../docs/guides/renderer-lib/paging-forge-toasts-errors.md#a-vendors-logo-is-not-an-icon--it-does-not-take-currentcolor)
before adding or theming a brand mark.

## A toast about a repository says which one — pass `subject`

Name the repo by id (`{ repoId }` or `{ worktreeId }`), never by name.
Read [Paging, forge hosts, toasts and
errors](../../../../../../docs/guides/renderer-lib/paging-forge-toasts-errors.md#a-toast-about-a-repository-says-which-one--pass-subject)
before raising a toast.

## A render error is logged by the root, and contained by `ErrorBoundary`

Logging is the root's job; use a boundary's `onError` for UI side effects
only.
Read [Paging, forge hosts, toasts and
errors](../../../../../../docs/guides/renderer-lib/paging-forge-toasts-errors.md#a-render-error-is-logged-by-the-root-and-contained-by-errorboundary)
before adding a boundary or changing renderer error reporting.
