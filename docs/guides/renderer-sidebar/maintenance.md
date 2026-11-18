# Repository maintenance dialog

This guide covers the Maintenance dialog: reattaching a run, its fixed frame and footers, and the Clones step.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/features/sidebar](../../../apps/desktop/src/renderer/src/features/sidebar/).

## A Maintenance run outlives its dialog

A reload keeps the webContents id, so main's `maintenance:run` goes on
after the dialog is gone. `maintenance:current` (scoped by the window's
`profileId`) hands the dialog back the live run or the profile's last
finished one; `maintenance-attach.ts` is the one way to use it.

- **Main and the dialog fold the same events** (`foldMaintenanceProgress`
  in `@pwrgit/shared`). Main's snapshot is that fold, updated in
  `progress()`. The dialogs hold it through `useMaintenanceRunView()`;
  don't keep run rows in hand-written `useState` again.
- **Subscribe before asking.** Events that arrive before the answer are
  held and folded after the snapshot; each carries `seq`. Two fast-check
  tests hold this: `maintenance-attach.property.test.ts` (reload anywhere,
  answer anywhere among live events, same view as a window that watched it
  all) and main's `maintenance-handlers.property.test.ts` (a model under
  `fc.scheduler`: never neither running nor finished, profile-scoped,
  owner-only cancel).
- **A receipt is shown once.** `maintenance:seen` marks it: on a dialog's
  own answer (even after a close cancelled it) and when a reattach draws
  it. The Sidebar reopens the dialog by itself only for a run this window
  started (`useReopenMaintenanceAfterReload`, `ownWindow`). Another
  window's run is shown, but its Cancel is disabled: main only lets the
  owner cancel. A live answer also says `cancelling`, so a run stopping
  before the reload is drawn as stopping.
- **A Combined plan does not resume.** Its steps lived in the lost dialog;
  the running step reattaches on its own tab. The Worktrees pruner runs
  `prune:*`, not `maintenance:run`, and does not reattach.

## Maintenance keeps one frame, and each footer ends with its primary

`.modal.maintenance` is `height: min(720px, 82vh)` on every screen. Never
size it to a screen's content (four `:has()` rules once did, and the footer
jumped between tabs). A screen's content goes in a scrolling body
(`.maintenance__body`, `.prune__setup`, `.prune__rows`).

The last footer button is the screen's primary (`modal__create`), and no
secondary follows it. When the job is done that is **Close**; running it again
is secondary. `e2e/maintenance-steady.spec.ts` checks both on every screen.
Design: `design/Maintenance Steady Height - UX Review.dc.html`.

## Clones is Combined's step 4, and the offer runs it alone

Combined runs Repair → Worktrees → Local branches → Clones → Garbage
collection (`STEP_ORDER`). Clones comes after the cleanup steps, so no time
goes into a worktree about to be removed, and before GC, which packs what
its main-checkout fetch brought in.

- **The step follows the Git in use** (`git:reflinkSupport`). Unable to
  re-share, it is unchecked and disabled, never hidden, and `runPlan` drops
  it. Start waits for the answer while Clones is planned.
- **The offer toast is raised once per profile** (`useClonesOffer`, 2 min
  after the window opens; main decides, see `main/git/AGENTS.md`). Share files
  opens the dialog with `CLONES_ONLY_PLAN` and `autoStart`; a dialog already
  open is left alone, because remounting it cancels its run.

Design: `design/Clones in Maintenance - UX Review.dc.html`.
