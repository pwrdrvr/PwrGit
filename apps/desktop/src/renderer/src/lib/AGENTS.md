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
