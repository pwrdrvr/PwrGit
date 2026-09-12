# e2e — AGENTS.md

Playwright drives the **built** Electron app (`out/main/index.js`) against real
git repos created in a throwaway temp dir. See the app `AGENTS.md` for the ABI
note — it matters here.

## Run

```bash
pnpm --filter @pwrgit/desktop test:e2e   # pretest builds out/, then playwright
```

`better-sqlite3` must be built for **Electron's** ABI (the default after
`pnpm i`). If you just ran `vitest` (which needs the Node ABI), the app will
crash on launch and `firstWindow()` will hang — run `pnpm i` first to restore
the Electron build.

## How a test is isolated

- **Data**: `PWRGIT_USER_DATA_DIR` (honored early in `src/main/index.ts`) points
  the db / settings / profiles at a fresh temp dir per launch, so every run
  starts from the seeded default profile — see `fixtures/electron-app.ts`. It
  also redirects the app log to `<dir>/logs/main.log`: macOS keys the default
  log directory off the app *name*, so without that a run would append to the
  installed app's own log.
- **Folder picker**: `dialog.showOpenDialog` is stubbed in the main process
  (`setPickDirectory`) so "Add repo folder…" is driven from the UI, not a native
  dialog.
- **Repos**: `fixtures/git-sandbox.ts` builds repos + linked worktrees with the
  system `git`, isolated from your global config (`GIT_CONFIG_GLOBAL=/dev/null`).
  `cleanup()` (in `afterEach`) deletes the whole tree.
- **Forges**: `fixtures/forge-fixture.ts` writes a mutable, file-backed provider
  fixture and `launchApp({ forgeFixturePath })` installs it at main's
  `ForgeRepoProvider` boundary. Renderer, IPC, services, real on-disk Git,
  indexing, SQLite and selection still run normally; no E2E may contact a real
  forge. Change fixture errors in place to cover retries without relaunching.

## Gotchas

- **Tear down anything a Git process is blocked on BEFORE `handle.cleanup()`.**
  `remote-activity.spec.ts` wedges a fetch against a `git://` socket it owns.
  Git for Windows runs git behind a launcher, so terminating the process
  PwrGit spawned can leave that grandchild alive, still blocked on the read
  and still holding the stdio pipes it inherited — and `app.close()` waits on
  those until Playwright's 60s test timeout. macOS and Linux pass either way,
  so this only ever shows up on the Windows job.

- **`hover()` cannot re-enter an element the pointer is already inside.** It
  moves the mouse and nothing more: with the pointer already within the target,
  Chromium dispatches a bare `mousemove` and no `mouseover`/`mouseout` at all,
  so React's `onMouseEnter` never fires again. A click leaves the pointer on
  the control it clicked, so `x.click()` followed later by `x.hover()` summons
  nothing — and the failure reads as "element(s) not found" for whatever the
  hover was supposed to open, pointing at the assertion rather than at the
  hover. To genuinely re-enter, leave first (`page.mouse.move` onto an inert
  element, asserting the old surface is gone) and then hover. This is what made
  `remote-activity.spec.ts` flaky; see `features/remote/AGENTS.md` for the
  app-side half.

- **A second Electron app on the machine will steal the pointer.** Playwright's
  Electron window is a real desktop window, so another suite launching windows
  — a sibling worktree running its own e2e, a `pnpm dev` from PwrAgnt — takes
  focus and Chromium fires a window-level `mouseleave` on whatever was hovered
  and clears the hover state. The signature is unmistakable:
  `document.querySelectorAll(":hover")` comes back **empty**, not pointing at
  some other element. Any spec that leaves the pointer resting on something
  across a wait can lose it that way. Before concluding a hover-dependent spec
  is broken, check for another `electron`/`playwright` process
  (`ps aux | grep -iE "[p]laywright|[E]lectron"`) and re-run alone; the
  config's `retries: 1` exists to absorb exactly this, so reproduce with
  `--retries=0` only on a quiet machine.

- **A test that depends on where the pointer is left resting must take the
  window off the real mouse first** — a third way to lose it, distinct from
  both above: the hover state is neither stale nor empty, it has moved to
  whatever sits under the *developer's own cursor*. The fix is
  `setIgnoreMouseEvents(true)` through `app.evaluate`, as
  `remote-activity.spec.ts`'s `ownThePointer` does.
  Playwright's pointer is injected over CDP and never moves the host's cursor,
  so the two coexist until Chromium recomputes hover after a layout change and
  dispatches a synthetic "fake mouse move" at the position its input pipeline
  last saw from the OS — i.e. wherever the developer's actual cursor is
  sitting. That evicts the synthetic pointer from the control it was parked on:
  `:hover` genuinely goes false and the feature correctly reacts to a pointer
  that left. It cost about one run in four, with the window and the real cursor
  in byte-identical positions every launch, so only the timing of the fake move
  varies and **no amount of waiting fixes it** — an earlier attempt to settle
  the window first looked clean over sixteen runs and then failed three in four.
  `setIgnoreMouseEvents` stops the OS delivering mouse input to the window;
  CDP injection is unaffected, so a fake move can only re-dispatch where
  Playwright already is. Ordinary click-and-assert specs are unaffected; this
  is for a test that reads hover state across a timer.

- Specs run as **ESM** — use `import.meta.url` + `fileURLToPath`, not
  `__dirname`.
- Confirms/alerts are **in-app** dialogs (not native), so drive them by clicking
  `.modal--dialog .modal__create` (confirm) / `.modal__cancel` — don't use
  Playwright's `window.on("dialog", …)`.
- Shared step helpers (`addRootAndExpand`, `expandRepoGroup`,
  `expandWorktrees`, `collapseWorktrees`, `repoGroup`, `branchRow`,
  `lensChip`) live in `fixtures/steps.ts`; a repo that trails its origin comes
  from `sandbox.makeRepoBehindRemote(name, { behindBy })`.
- **The lens switch is icon-only — reach it with `lensChip(window, "All")`,
  never `locator(".lens-chip", { hasText: … })`.** The chips carry no text, so
  a `hasText` filter matches nothing and burns the full click timeout before
  failing, with a message pointing at the click rather than at the selector.
  `lensChip` matches the accessible name, which also carries the count
  (`"Pinned (14)"`) — hence its prefix match. This is easy to reintroduce: a
  spec written against an older sidebar merges cleanly and only fails at
  runtime.
- **Never expand a disclosure with a bare `click()`.** Sidebar row clicks used
  to vanish for the first 250ms of a window's life: `useListReorder` seeded its
  post-drag suppression timestamp with `0`, and `performance.now()` counts from
  document load, so every early click read as the synthetic click a drag
  release fires. Expanding a repo the moment the sidebar lists it landed right
  on that boundary and failed about half the time, silently. That is fixed
  (`NO_DRAG_ENDED` in `useListReorder.ts`) — but keep using the helpers in
  `fixtures/steps.ts`, **including for closing** (`collapseWorktrees`), since a
  dropped click is not direction-specific. They read `aria-expanded` back,
  click again if it did not flip, and `console.warn` when they retry; that log
  is what found the bug. A `click N did not take` line from any spec other than
  `sidebar-expand.spec.ts` (which drops a click on purpose) means dropped
  clicks are back — investigate rather than raising a timeout.
