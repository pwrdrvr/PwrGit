# e2e — AGENTS.md

Playwright drives the **built** Electron app (`out/main/index.js`) against real
git repos created in a throwaway temp dir. See the app `AGENTS.md` for the ABI
note — it matters here.

## Run

```bash
pnpm --filter @pwrgit/desktop test:e2e   # pretest builds out/, then playwright
```

`pnpm i` stages separate Node and Electron native artifacts. Unit tests and
E2E need no rebuild between them. If an artifact is stale, use
`pnpm --filter @pwrgit/desktop run rebuild:electron-native`; see the desktop
`AGENTS.md` for the layout.

## Headed E2E in PwrSuiteLab

Prefer the available **PwrSuiteLab Control MCP**. Discover its live tools and
input schemas, then read its served `manage-pwrlab-e2e` skill: `skills/list` →
`skills/get` → `resources/read` (older clients: `resources/list` →
`resources/read`, using `skill://manage-pwrlab-e2e/SKILL.md`). In PwrAgent,
discover connected tools with `search_mcp_tools` and invoke them through
`call_mcp_tool`. Keep Control open. Its Operate grant authorizes exposed MCP
actions without per-operation native confirmation; Read only does not.
Controller ownership, target, and transport checks still apply.

1. Call `lab_status` and use the exact dedicated E2E target from `roles.e2e`.
   Never select a GHA runner, base image, or the physical Mac desktop. Check
   status again before submitting: idle shutdown or another owner can change
   state while you prepare. `lab_e2e_run` starts the configured VM if needed.
2. Inspect this checkout's `.nvmrc`, `packageManager`, scripts and lockfile.
   Commit authorized changes and verify the **exact absolute worktree path**
   is clean; never discard changes to achieve that. Control stages committed
   HEAD plus locally available submodule/LFS content. Host environments,
   ignored files and Git credentials do not travel. No GitHub push or existing
   guest PwrGit checkout is required; the repository must be local to Control.
3. Supply top-level `agent_name`, `project_name`, and `thread_name` on **both**
   `lab_e2e_run` and `lab_e2e_acquire`, including runs consuming a reservation.
   Use the real caller, `PwrGit`, and current thread title (or a descriptive task
   title). If applicable and known, `pr_number` is a decimal **string**; omit
   it otherwise. These are display labels, not authorization. Keep paths,
   credentials and private access URLs out of attribution.
4. Submit a `job` with `repository`, ordered `setup` argv arrays, test `command`
   argv, bounded checkout-relative `artifacts`, and a timeout covering setup
   plus testing (maximum 14400 seconds). Commands run **only in the guest**.
   Shell functions/compound commands require an explicit `["bash", "-c", "…"]`.
   Select the repository's Node version and install its dependencies in setup;
   never copy another product's build recipe or install tools on the host.

Example job shape below assumes nvm is already present in the guest. Replace
the target, repository, attribution and test selector before submission; add
`pr_number` only when known. If the runtime manager is missing, follow the
served skill's guest-only setup guidance.

```json
{
  "target": "<exact E2E target from lab_status>",
  "agent_name": "PwrAgent",
  "project_name": "PwrGit",
  "thread_name": "Verify desktop startup",
  "job": {
    "repository": "/absolute/path/to/clean/PwrGit/worktree",
    "setup": [["bash", "-c", "set -e; source ~/.nvm/nvm.sh; nvm install; nvm use; corepack enable; pnpm install --frozen-lockfile"]],
    "command": ["bash", "-c", "set -e; source ~/.nvm/nvm.sh; nvm use; pnpm test:desktop-e2e --grep 'startup'"],
    "artifacts": ["apps/desktop/test-results"],
    "timeout_seconds": 3600
  }
}
```

`test:desktop-e2e` builds the Electron app through `pretest:e2e`. The install
stages both native artifacts. Use the narrowest useful test selection and
request only relevant output directories, never the entire checkout or secrets.
The default reporter is `list`; request an HTML report only if you enable it.

Keep the returned request ID **and `run_id`**. Poll `lab_request_status` with
the request ID; a completed launch request or `job_state: running` does not
mean tests passed. Use `lab_e2e_collect` with the exact target and returned
`run_id` for run progress and artifacts; poll its request ID if still executing.
Read `e2e.log` and requested artifacts under the returned `artifact_directory`
(relative to the selected PwrSuiteLab checkout). Report tested commit, exit
code, and artifact completeness; distinguish checkout/setup/baseline failures
from test failures. Keep raw logs and artifacts out of Git. If the VM stopped,
use `lab_e2e_start` on that target before collecting the saved run; never rerun
tests just to retrieve results.

### Schema errors, ownership and recovery

For `Invalid tool or arguments` or an invalid-arguments response, refresh the
live schema and inspect missing fields/types, especially caller attribution.
This is a schema mismatch to diagnose, not evidence that Operate was revoked.
Do not repeatedly resubmit the same invalid payload, reconnect to change
ownership, or bypass a refusal with scripts/SSH. If a tool is genuinely absent
or authorization is explicitly denied, report that separately.

No acquire is needed before a run. Control consumes this OAuth connection's
existing reservation atomically, or claims the display; other owners are
refused. After handoff, the guest job owns and releases its workload lock.
`lab_e2e_release` / **Release reservation** applies only to a caller-owned
reservation, never a workload lock. Use acquire/open/release for interactive
reservations, not as cleanup after a successful job handoff.

Read `lock_started_at` as UTC (`Z`) and `lock_age_seconds` as the full guest
owner-file age, independent of the chart window or Control uptime. Age alone
does not establish an orphan or an expiry. After launch/transport failure,
inspect the saved run before retrying: it may already be running. An
`interrupted` result is not a passing test. Preserve locks and use guarded
`lab_e2e_recover` for orphaned workloads; it refuses live sessions, active
reservations, malformed owners and unknown transport state. Never delete locks
manually or terminate another owner's session.

Control owns strict SSH, configured identity and pinned host trust. Do not
guess users, enumerate keys, accept new host keys, forward an SSH agent or
explore credentials. Missing VM baseline prerequisites require a separate
operator-authorized repair; test setup does not authorize rebuilding the VM,
changing allocation/network/access, or installing on the physical host.

### Script fallback only when MCP is unavailable

Read the selected PwrSuiteLab checkout's `AGENTS.md` and
`macos-tart/README.md` before using its configured controller. From the clean,
committed PwrGit worktree on the approved Tart host:

```sh
<lab>/macos-tart/run-e2e.sh --confirm-live-run --workload pwrgit \
  --local "$PWD" [playwright arguments...]
```

Replace `<lab>` and the optional arguments. Preserve the original controller
safety constraints: exact dedicated E2E guest (never a runner/base), configured
strict SSH transport and provisioning markers, host/guest display locks,
marked disposable checkout, and explicit workload. Existing sessions/locks
remain owned work. Legacy launchers cannot consume a Control reservation;
release only your own unused reservation through Control first. Preserve
controller flags and authorization requirements; never use fallback to evade
an MCP denial or validation error. Follow the lab's guarded stale-lock recovery
procedure, not manual deletion or repeated launch attempts. Record the tested
commit and collected results, leave artifacts outside Git, and stop only an
idle guest that the authorized workflow owns.

## How a test is isolated

- **Release network**: every `launchApp` starts through `fixtures/bootstrap.cjs`,
  which blocks GitHub on main's fetch, Node HTTP(S), and Electron net transports
  before importing the app. Cleanup fails even if application code caught the
  blocked request. Updater UI specs use the unpackaged simulation; tests of
  production release checks must stub the transports, never forward to GitHub.
  Vitest installs the same guard for fetch and Node HTTP(S) in its setup file.
- **Data**: `PWRGIT_USER_DATA_DIR` (honored early in `src/main/index.ts`) points
  the db / settings / profiles at a fresh temp dir per launch, so every run
  starts from the seeded default profile — see `fixtures/electron-app.ts`. It
  also redirects the app log to `<dir>/logs/main.log`: macOS keys the default
  log directory off the app *name*, so without that a run would append to the
  installed app's own log.
- **Onboarding**: `launchApp` passes `PWRGIT_E2E_ONBOARDING_DONE=1`, which makes
  main's `ensureSeed` mark the seeded profile as already set up. Without it
  every launch is a genuine first run and the wizard's overlay
  (`position: fixed; inset: 0`) eats every click the spec makes — and says
  nothing about itself while doing it: two shards once burned the full
  20-minute job limit and the only annotation was "exceeded the maximum
  execution time". `launchApp` therefore reads the flag back through
  `profile:list` before returning and throws a named error if the seed did not
  take. `onboarding-wizard.spec.ts` is the one spec that passes
  `seedOnboarding: false`.
- **Folder picker**: `dialog.showOpenDialog` is stubbed in the main process
  (`setPickDirectory`) so "Add repo folder…" is driven from the UI, not a native
  dialog.
- **Repos**: `fixtures/git-sandbox.ts` builds repos + linked worktrees with the
  system `git`, isolated from your global config (`GIT_CONFIG_GLOBAL=/dev/null`).
  `cleanup()` (in `afterEach`) deletes the whole tree. A fixture that needs a
  stale `origin/<branch>` publishes from a separate clone, never by pushing
  this repo to the remote's path: Git 2.56 moves the tracking ref for that
  push (`src/main/git/AGENTS.md`).
- **Forges**: `fixtures/forge-fixture.ts` writes a mutable, file-backed provider
  fixture and `launchApp({ forgeFixturePath })` installs it at main's
  `ForgeRepoProvider` boundary. Renderer, IPC, services, real on-disk Git,
  indexing, SQLite and selection still run normally; no E2E may contact a real
  forge. Change fixture errors in place to cover retries without relaunching.

## Gotchas

- **Keep both hardware video codec switches in `launchApp`, even with
  `--disable-gpu`.** GPU rendering and media codecs are separate. PwrSnap
  #366 and PwrAgent #1168 measured VideoToolbox kernel-client leaks in Tart
  guests that eventually stall Electron teardown. The codec switches prevent
  accumulation; they do not repair an already-degraded guest. The separate
  `PWRGIT_E2E_DISABLE_GPU` gate must call `app.disableHardwareAcceleration()`
  before ready (PwrAgent #1656), as well as passing `--disable-gpu`. CI records
  `ioclasscount AppleVideoToolboxParavirtualizationUserClient` before and after
  each shard. Reboot degraded guests only after their active jobs finish.

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

- **Never click a palette row at its centre — use `pickPaletteHit`.**
  `locator(".overlay-result").click()` aims at the row's geometric centre, and
  a ⌘K/⌘F row's centre is not a stable place to put a pointer. The per-hit
  status chip is filled in lazily (asyncFill → `search:status`), the flexible
  `.overlay-result__name` gives up the ~56px it needs, and every control to
  the name's right slides left by that much. Measured against the real
  stylesheets at the palette's 620px width, `.pin` moves from x=350..374 to
  x=294..318 across a row centre of x=301 — so the click lands on the pin
  star, which calls `stopPropagation` and toggles a pin instead of picking the
  hit. Nothing opens, and the failure surfaces 30s later at whatever the spec
  awaited next (`waitForEvent("window")`, a modal), never at the click. This
  is what made `profiles.spec.ts`'s cross-profile reveal fail every run on
  macOS after #282, which only moved the timing; the geometry was already
  within 7px. `pickPaletteHit(hit)` in `fixtures/steps.ts` waits for the row
  and clicks its **name** — what a user aims at, and the one child of a row
  that cannot become a button. It works for every row kind (repo, worktree,
  branch, commit, file), so reach for it rather than adding a `.first()` or a
  `position` to a bare click. The rows clicked in `refs.spec.ts`,
  `tags.spec.ts`, `diff.spec.ts` and `lineage.spec.ts` are safe today only
  because those kinds render no pin star — one row-kind change away from the
  same failure.

- **Reach a page's native window with `app.browserWindow(page)`, never by
  title.** Every profile window loads the same URL, and its title stays
  index.html's `PwrGit` until `profile:list` answers and App renames it
  `PwrGit — <profile>`. Anything stamped earlier can be asserted first —
  `data-theme` comes from preload, before React loads — so a title read at that
  point can be the transient one. A `getAllWindows().find(getTitle() === …)`
  keyed on it then matches no window once the rename lands, and the poll
  returns `null` until it times out. That was `profiles.spec.ts`'s theme
  override flake. The handle is a `JSHandle<BrowserWindow>`; `evaluate` it
  directly.

- Specs run as **ESM** — use `import.meta.url` + `fileURLToPath`, not
  `__dirname`.
- Confirms/alerts are **in-app** dialogs (not native), so drive them by clicking
  `.modal--dialog .modal__create` (confirm) / `.modal__cancel` — don't use
  Playwright's `window.on("dialog", …)`.
- Shared step helpers (`addRootAndExpand`, `expandRepoGroup`,
  `expandWorktrees`, `collapseWorktrees`, `repoGroup`, `branchRow`,
  `lensChip`, `pickPaletteHit`) live in `fixtures/steps.ts`; a repo that trails its origin comes
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
