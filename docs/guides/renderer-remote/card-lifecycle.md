# Remote activity card lifecycle

This guide covers how the remote activity card opens on a click, settles into a receipt, and keeps its layout stable while an operation runs.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/features/remote](../../../apps/desktop/src/renderer/src/features/remote/).

## The click opens it; the outcome closes it

- **Every path out of an operation ends in exactly one of: `settle`,
  `dismiss` (a modal takes over: divergence dialog, SSH recovery prompt, fork
  prompt, publish question), or a toast (a failure the card could not
  carry).** Any other early return leaves a card pinned on "Starting…" until
  the user clicks it away.
- **Fetch, Pull and Push call `status.pin(button, scope)` before the
  dispatch.** The card shows from that moment: no age gate, no hover, no wait
  for main to register the operation.
- When the dispatch resolves, `status.settle({status, summary})` turns the
  same card into the receipt. A success drains a countdown rail and removes
  itself. A failure stays until dismissed.
- The card takes a `RemoteActivityView`, not a `RemoteActivity`. `finish()`
  deletes the record and publishes in the same step, so no record exists when
  the outcome arrives. `Pin` carries the scope taken at the click. `lastSeen`
  carries the final record, so the receipt can quote Git. Both are snapshots,
  never references.
- **Keep `busy` until the outcome is known**, including the local inspects
  that decide if a dialog takes over (divergence, SSH recovery). Otherwise the
  user can start an operation whose card the arriving dialog then dismisses.

### Staleness guards

The staleness guards return early and intentionally cannot settle. The
outcome belongs to a checkout that is no longer selected.

- `WorktreeHeader` dismisses on `worktree.id`, in its own effect. The reset
  effect beside it is declared before the hook that owns `dismiss`.
- `run` has the same `activeWorktreeId` guard as `onPull` and `onPush`.
  Without it, a fetch on a checkout you left settles the current checkout's
  card, under the wrong title. It also reports the outcome as carried, so the
  fallback toast never fires.
- All three also check one `remoteOperation` count, incremented by every
  start and every switch. `activeWorktreeId` reads the same again when the
  user returns, so without the count an outcome from the earlier visit lands
  on a later operation.

### Card or toast

`settle` returns whether a pinned card took the outcome; `flashError` uses
this. Do not show both a card and a toast for one failure. The anchored card
is the better report: it carries Git's output plus Logs and Copy. The toast is
the fallback when the user clicked the card away during the operation.

### Push with no upstream

Push on a branch with no upstream is the one click that pins **nothing**.

- It first asks `PublishBranchDialog` which remote to use. A plain push only
  gets Git's refusal and its `--set-upstream` advice for a terminal.
- The card pins on Publish, off the Push button that asked.
- A failure to load the remotes is a toast, never a `settle`. Any card still
  up belongs to an earlier operation.
- The remotes come from `repo:remotes` (one `git remote -v`), not
  `repo:refs`, which walks every ref while the button shows nothing.
- The header reads "no upstream" from the live snapshot, or the indexed row
  until a snapshot arrives. If both were stale, Git returns `no_upstream` and
  the header asks the same question. That is a `dismiss`, not a failure.

## The card accumulates; it does not narrate

**Rule: a row changes exactly once and is never moved or removed. Nothing is
wiped, so nothing needs re-reading.**

Why: phase transitions call `publish(true)` and bypass the 400&nbsp;ms
throttle. A card that rewrote its status line, command and output per phase
redrew five times in a 620&nbsp;ms pull (`prepare → fetch → fast_forward →
reapply → refresh`). That is unreadable, and most operations last under one
second.

- `activitySteps` turns the ordered, deduplicated phases of an operation into
  one row each.
- When a row's work ends, its label moves from present to past tense and its
  marker changes. That is its only change.
- The receipt is the same list with every marker changed.
  `RemoteActivityOutcome` carries `steps`, because `finish()` deleted the
  records the phases were observed on.
- **Bookkeeping earns no row.** `queued` waits on another operation's lock.
  `prepare` is a `git status` that main emits whether or not there is
  anything to stash. `refresh` is PwrGit's own work after Git. Drop these
  phases; do not show then remove them, because a removed row is a layout
  shift. While the operation is in one of them, every real step reads `done`
  (during `prepare`, the fetch above it has finished).
- **A phase Git re-enters is still one row.** A pull pops its stash in two
  places; that is one piece of work.
- **Below `REMOTE_ACTIVITY_NARRATE_AFTER_MS` there is no narration.** The card
  shows one stable line, then its receipt. The steps are still recorded, so
  the receipt is complete.
  - The gate controls what the card says, not whether it opens. The card
    still opens on the click.
  - **The gate covers the whole card, not the step list.** Gating only the
    list let the card fall back to `remoteActivityStatus`, which is the same
    per-phase narration.
  - Below the threshold, `startingView` is the view from the click until
    main's first output: one line, no meter, no command. It reads the record
    only for the id and `canceling` (so Cancel shows as soon as there is
    something to stop) and for the output tail (inside a collapsed
    disclosure, so it cannot move anything).
- **Git's output and the command line are collapsed while the operation looks
  healthy.**
  - The output is `\r`-rewritten progress. Live, it grew to its 108&nbsp;px
    cap while its last line flickered. It was the largest source of churn.
  - `setCommand` fires per Git invocation (about eight per pull), and 160
    monospace characters wrap differently each time.
  - The disclosure opens itself when it is the finding: a quiet warning, a
    failure, or a cancel. Command and last output are the two facts that
    diagnose a wedged transfer, so they stay together.
  - The open state is React-controlled. The popover re-renders every second,
    and an uncontrolled `<details>` would close under the user.

## The card grows; it never takes space back

**Rule: reserve space for anything the card draws for as long as it might
need it. While an operation runs, the card's height only increases.** An
element that appears and disappears moves the evidence block and buttons
below it twice.

- **The PHASE decides if a step has a progress track** (`stepHasMeter`), not
  whether Git has sent a percentage. Git reports only in the middle of a
  phase, and `setPhase` clears `progress`.
  - A `fetch` or `push` row has a track from the moment it is written. A
    `fast_forward` row never has one.
  - `Track` renders the reserved, empty case as presentational, not as a
    `progressbar` with an invented value. Assistive technology must hear
    "running, progress unknown", not "0%".
  - A finished network step reads 100%, in the success colour.
- **The fallback meter keeps its slot for the life of the operation**
  (`meterSlot`). The meter is the toast's standard presentation. The label
  line holds its height when empty, in CSS.
  - `meterSlot` is a field on the view, not derived by the card. The quiet
    card before the narration threshold must NOT reserve it. An empty block
    there would make that card taller than the step list that replaces it,
    so the transition would shrink the card.
- **The health line stays after it first has something to say.** If a quiet
  fetch resumes, update the line in place; do not remove it.
- **The Git-output disclosure stays on the receipt.** If a successful fetch
  has no output, show "Git produced no output." Removing the block moves the
  buttons up as the user reads the outcome.

Permitted movement is growth only: rows are **appended**, the disclosure
**opens** on a finding, and a failure headline appears above the list.

### Row labels

Rows carry bare labels. Counts (*"Fast-forwarded · 12 commits"*) need wider
results from main:

- `remote:fetch` returns only `{ remotes }` (the remotes it asked).
- `remote:push` returns `null`.
- `remote:pull` returns three booleans (`PullOutcome`).
- `pullFastForward` in `src/main/git/git-service.ts` reads the original HEAD
  but discards the commit range.

This is a smaller form of design card 3a's deferred protocol change.

### Where the steps come from

`liveActivityView` takes the steps as an argument. A record shows only the
current phase; the history belongs to the component that watched. The toast
passes no steps, so it gets the status line and the shared meter.
