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
  starts from the seeded default profile — see `fixtures/electron-app.ts`.
- **Folder picker**: `dialog.showOpenDialog` is stubbed in the main process
  (`setPickDirectory`) so "Add repo folder…" is driven from the UI, not a native
  dialog.
- **Repos**: `fixtures/git-sandbox.ts` builds repos + linked worktrees with the
  system `git`, isolated from your global config (`GIT_CONFIG_GLOBAL=/dev/null`).
  `cleanup()` (in `afterEach`) deletes the whole tree.

## Gotchas

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
