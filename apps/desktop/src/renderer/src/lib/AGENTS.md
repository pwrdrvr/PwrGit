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

## A tooltip is `hoverTooltip`, never a native `title`

There are no `title` tooltips left in `renderer/src`. Every one of them —
around 130 across the sidebar, graph, diff, rail, chrome and settings — now
goes through `hoverTooltip(tip, content)` from `useViewportTooltip.tsx`:

```tsx
const tip = useViewportTooltip();
<button {...hoverTooltip(tip, "Fetch all remotes")}>…</button>
{tip.tooltipNode}
```

One hook and one `tooltipNode` per component, however many triggers it has.
Four separate reasons, and the first is the one that matters most:

- **`title` is pointer-only.** It never appears on keyboard focus, so every
  keyboard user was being told nothing at all. `hoverTooltip` wires focus and
  blur alongside enter and leave, which is why it exists as a helper rather
  than four hand-written props — a call site cannot quietly reintroduce the
  gap by remembering only `onMouseEnter`.
- **`title` cannot be dismissed** (SC 1.4.13); the hook handles Escape.
- **`title` is not a reliable accessible name.** On a `<span>` it is advisory,
  and on a control with text content the content wins — `.diff-gutter--blame`
  announced as its own line number until it was given an `aria-label`.
- **On some elements it never rendered at all.** The `.repo-mark` glyphs are
  the recorded case: a bare 12×12 box around an SVG with `fill="none"` showed
  nothing, while `ForgeChip` beside it — same list, same row — showed its
  title fine. The cause was never pinned down. Don't chase it.

### A disabled control still gets a card — say it in both places

Chromium fires `mouseover`, `mouseenter` and `mousemove` on a disabled
`<button>`; only the click-shaped events are suppressed. **Verified by probe,
not assumed** — the opposite is the intuitive answer and it is wrong, so a
disabled control keeps whatever sentence explains why it is disabled.

**Repeat the visible label verbatim.** `aria-label` *replaces* a button's
contents for name computation, it does not add to them — so
`aria-label="Clone — unavailable, …"` on a button reading `Clone…` renames it,
and the name no longer contains its own visible label. That is SC 2.5.3, it is
what voice control matches on, and it is what every `getByRole("button", {
name })` in the e2e suite matches on: four specs went red on exactly this,
because the reason had been written in place of the label rather than after it.
The shape is **`<visible label, character for character> — unavailable,
<reason>`**, trailing ellipsis included.

It also goes in `aria-label`, and that half is not optional: a disabled button
still announces its name, and AT reads the name over any card. So
`.clone-repo` with no repo folder is named "Clone — unavailable, add a repo
folder before cloning" *and* carries the plain sentence on its card.

### What is not a tooltip

`grep 'title='` over this renderer still hits, and none of them should change:
a `title` prop on a component (`SettingsSection`, `SettingsPanelHead`,
`ReadError`, `GraphColumn`, `AuxiliaryTitleBar`) renders as a heading or an
`aria-label`; `<svg><title>` and `<iframe title>` are not tooltips either.

Two `title`s were deleted rather than converted, because the string was
already fully on screen: `.ssh-trust__link` (`overflow-wrap: anywhere`) and
`.refs-plan__notice small` (wraps). A card that repeats the line under the
pointer is noise. Check for `text-overflow: ellipsis` before assuming a
duplicated string is overflow recovery — most of them are.

### Testing it

The sentence only exists while something is hovered, so assert the **rendered
card** or the **accessible name** — never restore a `title` to make a spec
pass. In Playwright, `await el.hover()` then
`expect(window.getByRole("tooltip"))`. In vitest, dispatch a bubbling
`mouseover` inside `act` and read `[role="tooltip"]` from `document`
(`WorktreeRow.test.tsx`, `ForgeChip.test.tsx`). Two cards can be open at once
when each row owns its own hook, so a test that hovers several rows in turn
has to dispatch `mouseout` between them — a real pointer always does.

A static-markup test (`renderToStaticMarkup`) cannot see a card at all, and
`expect(markup).not.toContain("Drag to reorder")` now passes for a *draggable*
row too. Assertions of that shape are worse than useless after this change.

**Use `hoverTooltip(tip, content)`, not four hand-written handlers.** It is
exported beside the hook and returns
`onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur` together, because the two
halves are not optional separately: a mark that opens on hover but not on focus
is a mark a keyboard user never sees, and every hand-rolled copy eventually
drops one. The component owns the `useViewportTooltip()` and renders
`tip.tooltipNode`; the helper adds no state.

**The mixed-tooltip problem is the visible one.** A native `title` renders as
the OS tooltip — dark, square, bottom-right of the pointer — beside the light
card every other surface draws, so one 320px column ends up speaking in two
voices. The REMOTES list and the repo row are converted (`ForgeChip`, the
remote disclosure row, both fetch buttons, the fork verb, all three repo
marks); the rest of the renderer is not, and the sweep is tracked separately.
When you touch a surface that still has a `title`, convert it rather than
matching it.

**A `title` is not an accessible name.** On a `span` it is advisory and
unreliable. When you take one away, ask what it was carrying: if it was the
element's only name, replace it with `aria-label` (plus `role="img"` for a
meaningful glyph), and if the element sits INSIDE a control that already has a
name, make it `aria-hidden` — an `aria-label` there is spliced into the parent
button's name rather than read as its own, which is how `origin` became
"origin You can't push to desktop/dugite. Fork it to contribute. default".

## Popups shown on hover must be dismissible

`useViewportTooltip` handles Escape (WCAG 2.1 SC 1.4.13) and returns focus to
the trigger when the user had tabbed into the card. Anything that renders its
own hover surface outside that hook owes the same.

An interactive card is dismissed by any scroll — **unless the user has reached
it**, by pointer or by focus. Both halves matter: the pointer flag came first,
and focus was added when a second trigger (`WorktreeHeader`, after `GraphRow`)
started handing Tab into a card. A keyboard user sets no pointer flag, so
without it an unrelated scroll — the graph adjusting `scrollTop` as commits
stream in — took the card away with their focus still inside it.

### Nested triggers restore, they don't just hide

A row carries a card and the path inside it carries another. React fires no
`mouseenter` on an ancestor the pointer never left, so leaving the inner one
must put the outer one's card back — `hoverTooltip` leaves through `hideFrom`,
not `hide`, for exactly this. A native `title` did it for free; a plain `hide()`
leaves the pointer on a trigger showing nothing.

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

### A hover card claims Escape only if the keyboard summoned it

`useViewportTooltip` dismisses on Escape always; it calls `preventDefault` only
when the card is where the user actually **is** — focus inside the card, or a
trigger matching `:focus-visible`. A card the pointer opened does not claim,
because focus is elsewhere (in the diff pane, in a dialog) and that is the
surface the user meant. Swallowing the key there is unrecoverable without
moving the mouse, and moving the mouse is exactly what SC 1.4.13 says a user
must not have to do.

Claiming unconditionally was the original rule and it survived only because
few things carried cards. Converting the renderer off native `title` put a card
on nearly every control in `DiffPane` and `FileInsightsPane`, at which point the
pointer was **always** resting on one, and "Escape closes the diff pane" and
"Escape leaves file details" both went red in `e2e/diff.spec.ts`. The bug was
never in those panes; it was a hover card answering for a user who was not
looking at it.

`:focus-visible`, never `:focus` — Chromium focuses a button on click without
making it focus-visible, so the card left under the pointer by a click does not
pass as a keyboard one. The same browser fact `WHERE_THE_USER_IS` leans on in
`features/remote`. **jsdom answers `false` to `:focus-visible` for everything**,
so a unit test reaches the claiming branch by putting focus inside the card, not
by focusing the trigger.

**The dismissal latches the trigger, and a pin clears it.** After a claimed
Escape the trigger sits in `dismissedTargetRef` until the pointer or focus
leaves it, so restoring focus there cannot reopen what was just dismissed. The
latch is about that focus restore, not about the button — so `setSticky(true)`
drops it, a click or Enter being a fresh ask rather than a restore. Left set it
fails silently in both directions: `show` refuses, and the caller has no way to
see that it did. `features/remote` is where that bites, because a pin with no
card on screen still reports its outcome as *carried*, so the failure that
would have raised a toast is reported nowhere at all.

`onPointerWithin` is reported from the card's own root, so the padding ring
counts as inside it — and `hide()` reports `false` on the way out, because the
`mouseleave` that would otherwise say so never comes once the node is gone.

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

### Tab belongs to exactly one trap, by the same rule

Two traps can be open at once: `confirmDialog` from inside
`PruneWorktreesDialog` puts DialogHost's trap over Prune's. Each trap listens
on `window` and pulls stray focus back into itself, so with no owner rule the
lower trap took every Tab in the confirm and dragged focus behind it, and once
the confirm had a trap too the two fought until focus stuck on an edge.
`useFocusTrap` now resolves one owner per keypress: the trap holding focus
(deepest wins), otherwise the newest. A new trap gets this for free; don't add
a second keydown handler for Tab.

A menu portalled out of a trapped dialog (ImageLightbox's copy menu) is the
one case where focus outside the trap is not stray. The trap listens in the
capture phase, so it sees Tab first, and pulling focus in then left the menu
open: `useMenuNavigation` closes on Tab only while focus is still inside.
For focus inside a `[role="menu"]`, the trap claims the key but moves focus
only after the menu's own listener has run.

### A scroller can be a Tab stop with no tabindex

Chromium puts an overflowing scroller that holds nothing focusable into the Tab
order by itself (measured on 151: a nested pair yields only the inner one).
Its `tabIndex` still reads -1, so no selector finds it. `useFocusTrap` checks
layout for these when it works out where the cycle ends. Without that it wrapped
straight past one before a dialog's first control or after its last, and a long
facts list or Bulk Sync's results could not be scrolled from the keyboard.
Initial focus still skips them and lands on a control. jsdom does no layout, so
a test has to supply `scrollHeight`/`clientHeight` itself (see the trap's tests).

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

## Forge host classification comes from main, never from the hostname

`useForgeHostMap` reads the host → forge map over `forge:hosts`, and
`exactRepository` hands it to `parseForgeRemote` — the renderer's only
classifier; `classifyForgeHost` itself is called from shared and from main, not
from here. Do not classify a remote without the map: a
hostname is not evidence of which forge runs on it, so with no map every
self-managed instance reads as `other` and the clone and fork dialogs silently
lose a host the user is signed in to. `apps/desktop/src/main/forge/AGENTS.md`
has the whole rule.

The map is main's own (`ForgeHosts.overrides()`), shipped rather than derived
from the settings rows in the same response — the two are different sets. The
hook re-reads on `forge:statusChanged` because main enumerates hosts in two
background CLI spawns at boot, so a dialog opened in the first second would
otherwise cache an empty map for its whole lifetime. Reads are sequence-numbered
because those events arrive in bursts and the replies are not ordered — a stale
empty answer landing last pinned the degraded state for the dialog's lifetime.

Classifying in the renderer picks which forge to ask; it does **not** pick which
instance. `repo:checkCloneSource`, `repo:forkPreflight`, `repo:forkTargets` and
`repo:clone`/`repo:fork` therefore carry `hostname` as well as the kind, or main
answers from github.com/gitlab.com. `repo:searchCloneSources` is the exception
and is still SaaS-only — see `apps/desktop/src/main/forge/AGENTS.md`.

A slug carries no host. `chooseRepository` rewrites the query to
`owner/name`, which `exactRepository` can only resolve against the forge's SaaS
hostname — so the dialog remembers the instance the user picked and resolves the
slug back to it. Re-confirming an Enterprise repository against github.com is a
wrong answer, not merely a wasted round trip.

## A vendor's logo is not an icon — it does not take `currentColor`

Every glyph in this renderer is hand-transcribed from Lucide and painted with
`currentColor`. A trademark is the one case where that is the wrong instinct:
GitHub and GitLab (and Git itself) publish their marks and forbid redrawing or
recoloring them, so a stroke-language lookalike is our rendition of someone
else's logo, and a CSS filter over the real one is a recolor.

Brand marks therefore live as the vendors' own files under
`renderer/src/assets/<vendor>/`, each beside a README recording the source, the
usage rules, and the command that re-downloads it. They render as `<img>` —
never inlined as `<svg stroke="currentColor">` — inside a square box with
`object-fit: contain`, because none of these artboards is square and a bare
`width`/`height` pair would stretch the mark.

`brandTheme.ts` is the one subscription they share. Where a vendor publishes
per-theme colorways (GitHub's black and white Invertocat), `useBrandTheme()`
picks between THOSE FILES; a vendor that publishes one colorway (GitLab's
tanuki) keeps it on both themes. Pass `useBrandTheme(false)` when the caller
cannot use the answer — these marks sit on every repo row, and a subscriber
that ignores the value still holds the document-wide MutationObserver open.

`sidebar/ForgeMark.tsx` is the worked example.
