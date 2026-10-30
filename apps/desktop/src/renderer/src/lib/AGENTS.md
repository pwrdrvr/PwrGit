# renderer/lib — AGENTS.md

Shared renderer primitives. See `apps/desktop/AGENTS.md` for app-wide notes.

Rules that always apply here:

- **Open a hover popup through `hoverIntentHandlers`**, not raw `onMouseEnter`.
- **Show a tooltip with `hoverTooltip(tip, content)`.** Never add a native `title`.
- **Close a click-opened overlay with `useDismissable` / `useModal`.** Never hand-roll a keydown effect.
- **A `window` keydown handler calls `preventDefault` when it spends a key, and skips a key that is `defaultPrevented`.**
- **Pass `subject` on every toast about a repository.**
- **Never list remote branches or tags whole.** Page them through main.

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

### Nested triggers restore, they don't just hide

A row has a card, and a path inside it has another. React fires no
`mouseenter` on an ancestor the pointer never left. So `hoverTooltip` leaves
through `hideFrom`, not `hide`, which shows the outer card again. A plain
`hide()` leaves the pointer on a trigger that shows nothing.

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

## `useAutoPaging` re-observes on `loading`, never on `error`

- **Pass the real error state.** `null` brings back the request loop below.
- **Keep the "load more" control rendered.** It is the keyboard control, the
  retry after a failure, and the fallback where `IntersectionObserver` is
  undefined (the hook does nothing there).

`useAutoPaging` rebuilds its IntersectionObserver each time `loading` clears,
because the control does not move enough to emit a new intersection. Without
it, the fill stops after one page. A FAILED page also clears `loading` without
advancing the cursor. Re-observing then repeated the request without end: 200+
dispatches in a few microtask flushes, each a Git process. A failed page now
waits for the button.

The hook never requests one cursor twice. A caller that returns an unchanged
`nextCursor` stalls instead of looping.

## Remote branches are paged — never list them whole

`repo:refs` returns every **local** branch, but per remote only a six-row
`previewBranches` and a `branchCount`. Do not change this. On a fetched fork
network (openclaw, 4,470 remote-tracking refs), full lists were 1.5 MB of JSON
per call, held in renderer state, with one `<option>` per ref in the reset and
push dialogs.

To browse or pick past the preview, use `useRemoteBranchSearch`
(→ `repo:remoteBranches`). It debounces the query, filters in main, and returns
`{ rows, total }`.

- **Say what you truncated.** 50 of 4,466 with no marker looks like the whole
  remote. Render `RefsPageFooter` or the picker's status line.
- **Filter in main, not in the page.** A page filter hides matches past the
  first page.

`BranchRefPicker` is the shared "pick one ref" control (reset-to-remote, push
source). It stays a sized `<select>` for the native keyboard and screen-reader
model. A sized select has role **listbox**, not combobox; Playwright specs must
query listbox.

Tags: `repo:refs` carries only `previewTags` and `tagCount`. Tag browsers page
through `repo:tags` with `useTagSearch`. **A tag is never a `BranchRef`.** Do
not pass it to branch switching, branch pickers or worktree creation without a
UI that explicitly chooses detached HEAD or a new named branch.

## Forge host classification comes from main, never from the hostname

**Do not classify a remote without the host map.** A hostname does not show
which forge runs on it. Without the map, every self-managed instance reads as
`other`, and the clone and fork dialogs lose a signed-in host. Full rule:
`apps/desktop/src/main/forge/AGENTS.md`.

- `useForgeHostMap` reads the map over `forge:hosts`. `exactRepository` passes
  it to `parseForgeRemote`, the renderer's only classifier. Only shared code and
  main call `classifyForgeHost`.
- The map is main's own (`ForgeHosts.overrides()`), not derived from the
  settings rows in the same response. The two are different sets.
- The hook re-reads on `forge:statusChanged`. Main finds hosts in two
  background CLI spawns at boot, so a dialog opened in the first second would
  keep an empty map.
- Reads are sequence-numbered. Replies arrive in bursts, out of order, and a
  stale empty reply arriving last kept the degraded state.

The renderer picks the forge, **not** the instance. So
`repo:checkCloneSource`, `repo:forkPreflight`, `repo:forkTargets` and
`repo:clone`/`repo:fork` carry `hostname` with the kind. Otherwise main answers
from github.com/gitlab.com. `repo:searchCloneSources` is still SaaS-only.

A slug carries no host. `chooseRepository` rewrites the query to `owner/name`,
which `exactRepository` resolves only against the SaaS hostname. So the dialog
remembers the picked instance and resolves the slug against it. Checking an
Enterprise repository against github.com gives a wrong answer.

## A vendor's logo is not an icon — it does not take `currentColor`

Glyphs here are copied from Lucide and painted with `currentColor`.
Trademarks are the exception: GitHub, GitLab and Git forbid redrawing or
recoloring their marks. A lookalike is a redraw; a CSS filter is a recolor.

- **Use the vendor's files** under `renderer/src/assets/<vendor>/`. A README
  beside each records the source, the usage rules and the download command.
- **Render as `<img>`**, never as inline `<svg stroke="currentColor">`.
- **Use a square box with `object-fit: contain`.** No artboard is square, so a
  bare `width`/`height` stretches the mark.
- `brandTheme.ts` is the shared subscription. `useBrandTheme()` selects between
  a vendor's per-theme files (GitHub's black and white Invertocat). A vendor
  with one colorway (GitLab's tanuki) keeps it on both themes.
- **Pass `useBrandTheme(false)` when the caller ignores the answer.** The marks
  are on every repo row, and every subscriber keeps the document-wide
  MutationObserver open.

Worked example: `features/sidebar/ForgeMark.tsx`.

## A toast about a repository says which one — pass `subject`

`showErrorToast` / `showInfoToast` take `subject`. `ToastHost` draws it as
chips under the title (`diskhound › upstream`). The chips select the repo and
open it (and the remote's row) in the sidebar. Without them, three "Fetched
origin" toasts do not say whose origin, and the card outlives a repo switch.

- **Name by id, never by name:** `{ repoId }`, or `{ worktreeId }` from a
  surface that knows only its checkout (rail, diff, graph). The host reads the
  name from the live repo list. A repo no longer in the list draws no chip.
- **Add `remote: { name, url? }` for a toast about one remote.** Pass the fetch
  URL when known; its tooltip is the only way to tell two `upstream`s apart.
- **Don't repeat the repo name in the title.** The chip shows it.
- **Omit it only when there is nothing to go to** (`useRepoTree`'s "Removed …
  from the list") or the toast is not about a repository (app updates).

## A render error is logged by the root, and contained by `ErrorBoundary`

A render error with no boundary above it unmounts the whole React root: a
blank white window, a live renderer. `render-process-gone` does not fire, so
`main.log` used to record nothing.

- **Logging is the root's job.** `main.tsx` passes `rendererRootErrorOptions`
  ([renderer-errors.ts](renderer-errors.ts)) to `createRoot`. Every uncaught,
  caught and recoverable React error goes to `logs:reportRendererError` with
  its component stack. `installRendererErrorReporting` adds window `error` and
  `unhandledrejection`. Use a boundary's `onError` for UI side effects only.
- **Main owns the rate limit** (`src/main/renderer-errors.ts`): a burst of 10
  per window, then one per 6s, then a "suppressed N" line. A reload would reset
  a renderer-side limit.
- **Inside `act()`, React never calls `onUncaughtError`**; it queues the error
  for act to rethrow. Test the uncaught path outside act
  (`ErrorBoundary.test.tsx`).
- **Wrap a surface that can fail on its own:** a main-column pane
  (`PaneErrorFallback`, keyed with `resetKey` so a new target retries), or an
  overlay that should close and raise a toast (the image lightbox in
  `DiffViewer`). The root boundary is the last resort and offers Reload.
