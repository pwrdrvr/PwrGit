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
- Shared step helpers (`addRootAndExpand`, `expandWorktrees`, `repoGroup`,
  `branchRow`) live in `fixtures/steps.ts`; a repo that trails its origin comes
  from `sandbox.makeRepoBehindRemote(name, { behindBy })`.
- **Never expand a disclosure with a bare `click()`.** The sidebar re-renders
  while a newly added root is indexed, and a click that lands mid-render is
  dropped — the group stays collapsed and the spec times out much later on a
  `.wt-row` that cannot exist. The helpers in `fixtures/steps.ts` read
  `aria-expanded` back and click again; use them (or copy the shape) rather
  than assuming one click took.
