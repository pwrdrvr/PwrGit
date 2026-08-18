# Paired focus: working target and checked-out branch

Status: design, not yet implemented.
Scope: sidebar branch list, worktree rows, title bar breadcrumb, `branch:switch`.

## 1. What is broken

PwrGit already has one real focus — the selected worktree. Every verb in the
app aims at it: Pull, Push, Fetch, Commit, Discard, and (soon) Stash all act on
`selection.worktreeId`. That focus is well drawn: `.wt-row.is-selected` gets an
`--accent` border, a `--bg-row-active` tint, and sticks below the repo header.

The branch list under the same repo is, by contrast, inert. A branch row is a
copy target plus one mini-action (`●` reveal, or `+` create worktree). Nothing
in it says *"this is the branch the thing you are operating on is sitting
on."* `main` renders identically whether it is the branch under your cursor in
the main pane or a branch you have not touched in a year. Double-click does
nothing.

So the app shows the pair correctly in exactly one place — the title bar
breadcrumb, `PwrSnap › ● main › [pwrdrvr/PwrSnap]` — and nowhere else.

## 2. The model

There is **one** focus, with **two facets**, plus a third thing that is not a
focus at all and must never be styled like one.

| | Name | Cardinality | Owned by | Drives |
|---|---|---|---|---|
| A | **Working target** — repo + worktree | exactly one per window | `App.selection` | every git verb |
| B | **Checked-out branch** | derived from A, total | `worktree.branch` | display only |
| C | **Branch cursor** — the row last touched in a branch list | at most one, per repo | sidebar-local UI state | ⌘C, Enter, context menu |

The crucial asymmetry, which the design has to respect rather than paper over:

- **worktree → branch is a total function.** A worktree is always on exactly
  one branch (or detached). So B is *derived*. It is never stored, never
  independently settable, and never out of sync with A.
- **branch → worktree is partial.** A branch has zero or one worktrees. Most
  branches in a 161-branch repo have none.

That asymmetry is why B gets a *quieter, dependent* treatment than A rather
than an equal one. Two boxes of equal weight would claim there are two
selections. There is one selection and one reflection of it.

C is separate on purpose. It has no git meaning. It is where the keyboard is.

## 3. The one rule for activating a branch

> **Activating a branch row means: "make this branch the one I am working
> on." PwrGit takes the cheapest safe route to that.**

Which route depends on the branch's relationship to the repo's worktrees —
three cases, and the rule falls out of the partial function above:

| Branch state | Activation does | Cost |
|---|---|---|
| **Current** — checked out in the working target | nothing (scroll the lineage to its tip) | free |
| **Occupied** — checked out in *another* worktree of this repo | move the working target to that worktree | free — **no git operation at all** |
| **Free** — no worktree anywhere | `branch:switch` the working target to it, guarded | a checkout |

This is the part worth defending. Today the `●` button is labelled "Show
checked-out worktree" and is a distinct, separate affordance from `+` "Create
worktree". Under the rule above they stop being two different verbs the user
has to choose between and become two implementations of the same intent. The
user says "work on this branch"; the app knows a worktree already holds it and
just goes there, instead of failing with git's *"already used by worktree"*.

`+` (create a worktree for this branch) survives as an explicit secondary
action, not as the primary meaning of the row.

Activation is bound to: **double-click**, **Enter** on the focused row, and
**Switch here** in the row's context menu. Double-click alone is not
sufficient — a pointer-only activation fails SC 2.1.1, and the app already
has the accessible route in `BranchSwitcher`.

## 4. Visual spec

### 4.1 The checkout chip

Replace the bare `●` / `+` mini-action with a chip on the row's tail that names
**which worktree** holds the branch.

The chip must not repeat the branch name. Branch↔worktree is 1:1, so labelling
a worktree by its branch says nothing new — the row already says it. Label it
by its **path basename**, which is the only distinguishing information a
worktree carries:

```
BRANCHES  161  ·  on main

│ ⑂ main                        Synced    ⌂ PwrSnap            ← current
  ⑂ claude/wonderful-nobel…     Missing   ⑂ PwrSnap-wonderful  ← occupied
  ⑂ claude/musing-gauss-da9…    Missing   +                    ← free
  ⑂ claude/sad-joliot-c49ea6    Missing   +
```

- `⌂` for the repo's primary checkout, `⑂` for a linked worktree — the same
  two glyphs the worktree rows already use.
- Chip click = reveal + focus that worktree (today's `●` behaviour, kept as a
  single-click shortcut).
- `+` keeps its current meaning and stays a plain mini-action, not a chip.

### 4.2 The three row states

| State | Left bar | Branch icon | Name | Chip | Row background |
|---|---|---|---|---|---|
| **current** | `inset 2px 0 0 var(--accent)` | `--accent` | `--text-primary`, 500 | filled: `--accent-soft` bg, `--accent-bright` text, `--accent-border` | `--bg-row-active` |
| **occupied** | none | `--text-secondary` | `--text-secondary` | outline: transparent bg, `--text-muted` text, `--border-subtle` | transparent |
| **free** | none | `--text-muted` | `--text-secondary` | — (`+` mini-action) | transparent |

The **bar, not a box** is the whole point of the pairing. The worktree row
keeps its 1px `--accent` border box — that is "this *is* the selection". The
branch row gets the 2px inset accent bar — the vocabulary `.wt-row.is-multiselected`
already uses for *"related to the selection, but not it."* Same accent family,
strictly lower rung. A reader scanning the sidebar sees one box and one bar and
correctly reads them as a pair, not as a contradiction.

`--bg-row-active` on the current branch row is the same tint the selected
worktree row carries, which reinforces the pairing at a glance; the bar carries
the SC 1.4.11 weight, exactly as the border does on `.wt-row.is-selected`
(the tint alone is ~1.03:1 — see the note there).

### 4.3 The collapsed-section summary

`BRANCHES 161` becomes `BRANCHES 161 · on main` whenever the working target is
a worktree of this repo. This is the cheap 90% of the pairing: it is visible
without expanding 161 rows, and it makes the sidebar agree with the title bar
at rest.

For a detached worktree the suffix reads `· detached`. (`Worktree.branch` is
`detached@0123456` in that case, so no local branch row will match it — the
current-state styling correctly applies to nothing, and only the summary needs
the special case.)

### 4.4 Pinning the current branch into view

`RepoRefsSections` renders `refs.branches.slice(0, 6)`. In the screenshot `main`
happens to land in that slice; a feature branch would not, and the pairing
would be invisible in the exact case where it matters most.

**The current branch is pinned as the first visible row**, followed by up to 5
more from the existing ordering, de-duplicated. Occupied branches are *not*
pinned — with 48 worktrees that would consume the whole slice.

## 5. The reverse direction: selecting a worktree

The user's second question. Rules, in order of importance:

1. **Selecting a worktree sets the branch focus. Always, immediately, with no
   confirmation.** B is derived from A; there is nothing to decide.
2. **Selecting a worktree does not expand, scroll, or reorder the branch
   section.** Clicking through worktrees is a high-frequency browse action;
   making the sidebar jump each time is worse than the problem it solves. The
   collapsed summary (§4.3) is what keeps the user informed.
3. **The branch cursor (C) is cleared** when the working target moves to a
   different repo, and left alone otherwise. It is a keyboard position, not a
   selection; it should not survive a context switch.
4. **Cross-repo:** `is-current` is unique across the *window* — at most one
   branch row in the entire sidebar wears it, and only in the repo that owns
   the working target. `occupied` is per-repo and can appear in every repo at
   once. This distinction is what stops the sidebar from looking like it has 12
   simultaneous selections.
5. **Activating a branch in a repo that is not the working target** first moves
   the working target to that repo's primary worktree, then applies §3 against
   it. State this in the confirm dialog, because it is a two-part action:
   *"Switch PwrSnap (primary checkout) to `claude/sad-joliot`?"*

## 6. The safety gate

`switchBranch` already classifies failures into `checked_out_elsewhere`,
`dirty`, and `switch_failed`. Under §3 the first is unreachable — an occupied
branch never reaches `branch:switch`. That leaves dirt.

Note that `git switch` *succeeds* with uncommitted changes when they do not
conflict, carrying them to the new branch. That is sometimes what you want and
sometimes a genuine footgun, and the user cannot tell which from the sidebar.
So it is gated, not attempted blind:

- **`dirty === 0`** → switch immediately. No dialog. This is the common case
  and a dialog here would make the feature feel expensive.
- **`dirty > 0`** → confirm sheet, naming the worktree, the count, and the
  destination. Choices: **Carry changes over** / **Cancel**. When stash lands,
  **Stash and switch** becomes the recommended first option.
- **A rebase/merge/cherry-pick is in progress, or the worktree operation queue
  is busy** → refuse up front with the reason. Do not queue a checkout behind a
  rebase.
- **Anything else** → let git decide and surface `switch_failed` as an error
  toast (the existing pattern), because git is the authority on *"would be
  overwritten by checkout."*

**Staging.** v1 reads `dirty` off the `Worktree` already in the tree and calls
the existing `branch:switch` — no protocol change. v2 adds
`branch:inspectSwitch` returning `{ dirty, conflicting, operationInProgress }`,
following the established `remote:inspectDivergence` / `remote:inspectReset`
inspect-then-act pattern, so the dialog states facts rather than an estimate.

## 7. Keyboard and accessibility

Branch rows are `div`s today with a single `CopyTarget` button inside — not
reachable as rows, not announced as list items.

- Branch rows join the sidebar tree as `role="treeitem"` at `aria-level={3}`
  under their section, with a roving tabindex per repo (the same pattern
  `WorktreeRow` uses).
- `aria-current="true"` on the current-branch row. This is the accessible
  half of the pairing and is what makes it survive without color.
- `Enter` = activate (§3). `Space` = set cursor. `⌘C` = copy branch name.
  Context menu = Switch here / New worktree from this branch / Reveal worktree
  / Copy name.
- The current state must not be color-only. The `⌂ PwrSnap` chip carries text,
  and `aria-current` carries it for AT — the accent bar is reinforcement.

**Known cost, flagged rather than hidden:** today the branch *name* is a click
target that copies. Making the row activatable means the row's single-click
must set the cursor instead. Recommendation: keep copy on the name's existing
narrow hit box for continuity, and add ⌘C on the focused row as the discoverable
path. If that double meaning tests badly, move copy to a hover action outright
— but that is a change to a working affordance and should be a deliberate
second step, not a side effect of this one.

## 8. Where the code changes

| File | Change |
|---|---|
| `features/sidebar/RepoRefsSections.tsx` | new props `focusedWorktree`, `worktreesById`; three-state row rendering, checkout chip, pinned current branch, section summary, dbl-click/Enter |
| `features/sidebar/RepoRow.tsx:628` | pass `selectedWorktreeId` + `repo.worktrees` down (both already in scope) |
| `features/sidebar/RepoRefsModal.tsx` | same three states in the "View all 161 branches" list — the states must not differ between the slice and the modal |
| `styles/app.css` | `.ref-branch-row.is-current` / `.is-occupied`, `.ref-checkout-chip` |
| `App.tsx` | expose an `activateBranch(repoId, branch)` that resolves §3 and §5.5 |
| `features/shell/dialogs.ts` | the dirty-switch confirm |
| `main/git/branch-handlers.ts` | v2 only: `branch:inspectSwitch` |

No change to `Worktree`, `RepoRefs`, or `LocalBranchSummary` — `checkedOutWorktreeIds`
plus `repo.worktrees[].path` already carry everything the chip and the three
states need.

## 9. Rejected

- **A second selection box on the branch row.** Reads as two competing
  selections; contradicts the fact that B is derived.
- **A drawn connector between the worktree row and its branch row.** Fragile
  across scrolling, collapsed sections, and the 6-row slice, and worthless the
  moment either end is off-screen.
- **Auto-expanding the branches section on worktree select.** Makes the most
  common sidebar interaction jump; §4.3 gets the same information for free.
- **Storing branch focus as independent state.** It can then disagree with the
  worktree, and every consumer has to decide which to believe.
- **Double-click on an occupied branch attempting a checkout.** Git refuses,
  and the refusal teaches the user nothing they wanted to know. Going to the
  worktree is what they meant.
