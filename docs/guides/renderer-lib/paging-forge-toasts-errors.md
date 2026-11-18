# Renderer paging, forge hosts, brand marks, toasts and render errors

This guide covers auto-paging, paged remote branches and tags, forge host classification, vendor logos, toast subjects, and render-error logging.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/lib](../../../apps/desktop/src/renderer/src/lib/).

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

Tags: `repo:refs` carries only `previewTags`, `tagCount` and the stored
`tagAttention` count. The Tags tab pages through `repo:tagStatus` with
`useTagStatus`, which compares local tags with the published remote's stored
snapshot in main and never reaches the network. Remote-only rows have no
`TagSummary`: act on `row.local`, and offer only Download where it is null.
**A tag is never a `BranchRef`.** Do
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
  ([renderer-errors.ts](../../../apps/desktop/src/renderer/src/lib/renderer-errors.ts)) to `createRoot`. Every uncaught,
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
