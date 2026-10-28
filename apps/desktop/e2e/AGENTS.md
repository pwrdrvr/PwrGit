# e2e — AGENTS.md

Playwright drives the **built** Electron app (`out/main/index.js`) against
real git repos in a throwaway temp dir. The ABI note in the app `AGENTS.md`
applies here.

## Run

```bash
pnpm --filter @pwrgit/desktop test:e2e   # pretest builds out/, then playwright
```

`pnpm i` stages separate Node and Electron native artifacts, so unit tests and
E2E need no rebuild between them. If an artifact is stale, run
`pnpm --filter @pwrgit/desktop run rebuild:electron-native` (layout: desktop
`AGENTS.md`).

## Headed E2E in PwrSuiteLab

Run headed E2E only on the dedicated lab E2E VM, never on a GHA runner or the
physical host desktop. Before you submit a job, read
[docs/headed-e2e-pwrsuitelab.md](../../../docs/headed-e2e-pwrsuitelab.md):
MCP job shape, ownership and lock rules, and the script fallback.

## Harness pages

- `e2e/harness/<name>/` mounts real renderer components against a fake
  preload bridge with contrived data. Use it for layout that jsdom tests cannot
  see.
- `harness/build.ts` builds it with Vite. `harness/electron-main.cjs` loads it
  in a window that is never shown and, on macOS, takes no Dock icon or focus.
  So a spec like `section-headings.spec.ts` runs in CI with the other E2E, is
  safe on a developer's machine, and needs no `out/`.
- Load every font a check reads before you mount. Otherwise the first
  measurement uses a fallback face.
- `PWRGIT_HARNESS_SHOTS=<dir>` writes that spec's grid as a PNG for a PR's
  before/after shots. [docs/pr-screenshots.md](../../../docs/pr-screenshots.md)
  has the other routes.

## How a test is isolated

- **Release network — no E2E may contact GitHub.** Every `launchApp` starts
  through `fixtures/bootstrap.cjs`. It blocks GitHub on main's fetch, Node
  HTTP(S) and Electron net transports before it imports the app. Cleanup fails
  even if app code caught the blocked request. Updater UI specs use the
  unpackaged simulation. Tests of production release checks must stub the
  transports, never forward to GitHub. Vitest's setup file installs the same
  guard for fetch and Node HTTP(S).
- **Data**: `PWRGIT_USER_DATA_DIR` (read early in `src/main/index.ts`) points
  db, settings and profiles at a fresh temp dir per launch, so every run starts
  from the seeded default profile (`fixtures/electron-app.ts`). It also moves
  the app log to `<dir>/logs/main.log`. Without it, a run appends to the
  installed app's log, because macOS keys the log directory to the app *name*.
- **Onboarding**: `launchApp` passes `PWRGIT_E2E_ONBOARDING_DONE=1`, so main's
  `ensureSeed` marks the seeded profile as set up. Without it, the first-run
  wizard's overlay (`position: fixed; inset: 0`) silently eats every click,
  and shards hit the 20-minute job limit ("exceeded the maximum execution
  time"). `launchApp` reads the flag back through `profile:list` and throws a
  named error if the seed did not take. Only `onboarding-wizard.spec.ts` passes
  `seedOnboarding: false`.
- **Folder picker**: `dialog.showOpenDialog` is stubbed in main
  (`setPickDirectory`), so the UI drives "Add repo folder…".
- **Repos**: `fixtures/git-sandbox.ts` builds repos and linked worktrees with
  the system `git`, isolated from your global config
  (`GIT_CONFIG_GLOBAL=/dev/null`). `cleanup()` (in `afterEach`) deletes the
  tree. For a stale `origin/<branch>`, publish from a separate clone. Never
  push this repo to the remote's path: Git 2.56 moves the tracking ref for that
  push (`src/main/git/AGENTS.md`).
- **Forges — no E2E may contact a real forge.** `fixtures/forge-fixture.ts`
  writes a mutable, file-backed provider fixture.
  `launchApp({ forgeFixturePath })` installs it at main's `ForgeRepoProvider`
  boundary. Renderer, IPC, services, on-disk Git, indexing, SQLite and
  selection run normally. To test retries without a relaunch, change fixture
  errors in place.

## Gotchas

- **Keep both hardware video codec switches in `launchApp`, even with
  `--disable-gpu`.** GPU rendering and media codecs are separate. PwrSnap #366
  and PwrAgent #1168 measured VideoToolbox kernel-client leaks in Tart guests
  that eventually stall Electron teardown. The switches prevent accumulation
  but do not repair a degraded guest. The `PWRGIT_E2E_DISABLE_GPU` gate must
  call `app.disableHardwareAcceleration()` before ready (PwrAgent #1656) and
  pass `--disable-gpu`. CI records
  `ioclasscount AppleVideoToolboxParavirtualizationUserClient` before and after
  each shard. Reboot a degraded guest only after its active jobs finish.

- **Tear down anything a Git process is blocked on BEFORE `handle.cleanup()`.**
  `remote-activity.spec.ts` stalls a fetch on a `git://` socket it owns. Git for
  Windows runs git behind a launcher, so killing PwrGit's child can leave the
  grandchild blocked and holding the inherited stdio pipes. `app.close()` then
  waits until Playwright's 60s test timeout. This fails only on the Windows
  job.

- **`hover()` cannot re-enter an element the pointer is already inside.** It
  only moves the mouse. Inside the target, Chromium sends a bare `mousemove`
  with no `mouseover`/`mouseout`, so React's `onMouseEnter` does not fire. A
  click leaves the pointer on its control, so `x.click()` then `x.hover()`
  opens nothing. The failure reads "element(s) not found" at the assertion, not
  the hover. To re-enter, `page.mouse.move` onto an inert element, assert the
  old surface is gone, then hover. This made `remote-activity.spec.ts` flaky;
  `features/remote/AGENTS.md` has the app-side half.

- **A second Electron app on the machine will steal the pointer.**
  Playwright's window is a real desktop window. Another suite that opens
  windows (a sibling worktree's e2e, a PwrAgnt `pnpm dev`) takes focus, and
  Chromium fires a window-level `mouseleave` that clears hover state.
  Signature: `document.querySelectorAll(":hover")` is **empty**, not another
  element. Before you call a hover-dependent spec broken, check
  `ps aux | grep -iE "[p]laywright|[E]lectron"` and run it alone. The config's
  `retries: 1` absorbs this; use `--retries=0` only on a quiet machine.

- **A test that depends on where the pointer is left resting must take the
  window off the real mouse first.** Call `setIgnoreMouseEvents(true)` through
  `app.evaluate`, like `ownThePointer` in `remote-activity.spec.ts`.
  - Symptom: hover moves to the element under the *developer's own cursor*
    (not stale, not empty). About one run in four fails.
  - Cause: Playwright injects its pointer over CDP and never moves the host
    cursor. After a layout change, Chromium recomputes hover with a "fake mouse
    move" at the last OS cursor position. `:hover` really becomes false.
  - **No amount of waiting fixes it.** Only the fake move's timing varies; a
    settle-first attempt passed sixteen runs, then failed three in four.
  - `setIgnoreMouseEvents` blocks OS mouse input but not CDP injection, so a
    fake move re-dispatches where Playwright already is.
  - Only tests that read hover state across a timer need this.

- **Never click a palette row at its centre — use `pickPaletteHit`.**
  - `locator(".overlay-result").click()` aims at the centre of a ⌘K/⌘F row,
    which moves. The status chip fills in lazily (asyncFill →
    `search:status`), the flexible `.overlay-result__name` gives up ~56px, and
    controls right of the name shift left.
  - At the palette's 620px width, `.pin` moves from x=350..374 to x=294..318,
    across the row centre x=301. The click toggles the pin star
    (`stopPropagation`) and picks nothing.
  - The failure shows 30s later at the next await (`waitForEvent("window")`,
    a modal), never at the click. This broke `profiles.spec.ts`'s cross-profile
    reveal on every macOS run after #282.
  - `pickPaletteHit(hit)` in `fixtures/steps.ts` waits for the row and clicks
    its **name**, the one child that cannot become a button. It works for every
    row kind (repo, worktree, branch, commit, file). Use it instead of
    `.first()` or a `position` on a bare click.
  - Rows clicked in `refs.spec.ts`, `tags.spec.ts`, `diff.spec.ts` and
    `lineage.spec.ts` are safe only because those kinds show no pin star.

- **Reach a page's native window with `app.browserWindow(page)`, never by
  title.** Every profile window loads the same URL. Its title is index.html's
  `PwrGit` until `profile:list` answers and App renames it
  `PwrGit — <profile>`. A spec can assert earlier state first (`data-theme`
  comes from preload), so it can read the transient title. A
  `getAllWindows().find(getTitle() === …)` then matches nothing after the
  rename and polls `null` until timeout (the `profiles.spec.ts` theme override
  flake). The handle is a `JSHandle<BrowserWindow>`; `evaluate` it directly.

- Specs run as **ESM**. Use `import.meta.url` + `fileURLToPath`, not
  `__dirname`.
- Confirms and alerts are **in-app** dialogs. Click
  `.modal--dialog .modal__create` (confirm) or `.modal__cancel`. Do not use
  Playwright's `window.on("dialog", …)`.
- Shared step helpers live in `fixtures/steps.ts`: `addRootAndExpand`,
  `expandRepoGroup`, `expandWorktrees`, `collapseWorktrees`, `repoGroup`,
  `branchRow`, `lensChip`, `pickPaletteHit`. For a repo behind its origin, use
  `sandbox.makeRepoBehindRemote(name, { behindBy })`.
- **The lens switch is icon-only — use `lensChip(window, "All")`, never
  `locator(".lens-chip", { hasText: … })`.** The chips have no text, so
  `hasText` matches nothing and fails after the full click timeout, blaming the
  click. `lensChip` prefix-matches the accessible name, which includes the
  count (`"Pinned (14)"`). Specs written against an older sidebar merge clean
  and fail only at runtime.
- **Never expand a disclosure with a bare `click()`.** Use the
  `fixtures/steps.ts` helpers, **also to close** (`collapseWorktrees`).
  - They read `aria-expanded` back, click again if it did not change, and
    `console.warn`.
  - A `click N did not take` line from any spec except
    `sidebar-expand.spec.ts` (which drops a click on purpose) means dropped
    clicks are back. Investigate; do not raise a timeout.
  - Past cause, now fixed (`NO_DRAG_ENDED` in `useListReorder.ts`):
    `useListReorder` seeded its post-drag suppression timestamp with `0`, and
    `performance.now()` counts from document load. So clicks in a window's
    first 250ms were dropped as drag-release clicks. Early expands failed about
    half the time, silently.
