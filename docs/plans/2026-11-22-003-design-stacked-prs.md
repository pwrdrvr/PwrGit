# Stacked pull requests: model, operations, UI and MCP

Status: proposed. Nothing here is built. The board is
[`design/Stacked PRs - UX Review.dc.html`](../../design/Stacked%20PRs%20-%20UX%20Review.dc.html),
which is also live on the PwrGit design canvas. It has a working prototype of
every operation in turn 3.

Scope: stack state, the stack engine (restack, sync, submit, reorder), the
Stacks sidebar section, the stack view, lineage-graph annotations, undo, and
the first write tools on PwrGit's MCP server.

PwrAgent's design is pwrdrvr/PwrAgent#4190 (`docs/design/stacked-prs.md`).
There is **no shared package**. PwrAgent copies this engine design into its
own `packages/owner-core` and owns that copy. Whichever app builds the engine
first, the other copies the code. The copies stay honest through the same
tests: §8's model and atomicity tests, the gh stack v0.3.0 interop oracle, and
the #586 fixture. The two apps share only gh stack's catalog and its two
locks (§2). Each keeps its own journal and undo refs.

## 1. What exists, and what is missing

PwrGit has no stack feature. What exists, and what this design builds on:

| Have | Where | Used for |
|---|---|---|
| PR `baseRefName` / `headRefName` on every fetch | `PrSummary` in `packages/shared/src/types.ts`, `PR_NODE_FIELDS` in `main/github/pr-query.ts` | Inferring a chain from PR bases |
| A stack drawn as one lane train | `renderer/src/features/graph/lane-layout.ts` (in-place lane handover) | The lineage annotation needs no new geometry |
| Draft → check → apply with a proof and an `approvalToken` | `main/git/rebase-assistant.ts`, `rebase:draft/check/apply` | The plan/apply contract and the proof ledger |
| Push with an explicit lease | `remote:pushBranchWithLease` (`git-service.ts`) | Submit |
| In-progress operation banner | `operation-service.ts`, `features/rail/OperationBanner.tsx` | A restack paused at a conflict |
| Ordered repository and worktree locks | `WorktreeOperationQueue` (`main/git/AGENTS.md`) | Serializing stack operations |
| `→ base` on a PR row whose base isn't trunk | `shownBase()` in `features/sidebar/change-request-groups.ts` | All of today's stack UI |

Missing: any record of a branch's parent; `--onto` rebases; rebasing anything
but the current branch; opening a PR or changing its base (the only forge
write is merge-queue enqueue); undo; and any MCP tool that writes.

Two more facts shaped the design:

- The team already stacks with GitHub's official `gh stack` extension
  (v0.3.0). PwrAgent's `docs/gh-stack-workflow.md` records its use and a
  squash-merge boundary bug fixed upstream in github/gh-stack#586. gh stack
  keeps a catalog at `$GIT_COMMON_DIR/gh-stack` and a stack object on GitHub.
- The bundled Git is 2.56. That makes `git replay` (2.44+) and
  `git merge-tree --write-tree` (2.38+) available everywhere PwrGit runs.

## 2. State: the gh stack catalog

**Decision:** read and write gh stack's catalog. Don't invent a fourth format.

The catalog lives at `$GIT_COMMON_DIR/gh-stack` (schema v1), and every linked
worktree shares it:

```json
{
  "schemaVersion": 1,
  "repository": "github.com:owner/repo",
  "stacks": [{
    "trunk": { "branch": "main", "head": "<sha>" },
    "branches": [
      { "branch": "a", "head": "<sha>", "base": "<parent tip a was built on>",
        "pullRequest": { "number": 651, "id": "PR_…", "url": "…" } }
    ]
  }]
}
```

`base` is the field that matters. It records the parent tip a branch was last
built on, which is the `--onto` anchor every restack needs.

Rules (from gh stack v0.3.0 source at `2a49e67`, `internal/stack/lock.go`):

- **Two `flock` files in the common dir.** gh stack holds
  `gh-stack-operation.lock` for a whole command and takes `gh-stack.lock` for
  catalog writes, always in that order. Both are taken with
  `LOCK_EX|LOCK_NB`, retried every 100 ms, and give up after 5 s. On Windows
  it's `LockFileEx` on byte 0. The files hold no PID and are never unlinked.
  So "busy" means a non-blocking lock attempt fails, never "the file exists".
- **PwrGit takes the same locks in the same order, and only for the apply
  window.** Planning runs unlocked, because apply re-checks every expected tip
  and the catalog hash anyway. Holding the operation lock any longer makes a
  `gh stack` command run elsewhere fail after its 5 s timeout.
- **A catalog write is a compare-and-swap on the file's SHA-256.** Read and
  hash, change only the stack being edited, then re-hash under
  `gh-stack.lock`. If the hash changed, re-read and redo the edit. Write a
  temp sibling, fsync it, rename it over the catalog, then fsync the
  directory.
- **Add no fields to the catalog.** gh stack re-marshals from Go structs, so
  its next write drops any unknown field. Anything PwrGit-specific lives in
  PwrGit's journal or SQLite, never in the catalog.
- **Journals that mean "this clone is busy".** While any of these exist, every
  mutating stack operation is refused, with the owner named ("gh stack is
  mid-rebase in this clone"):
  - gh stack's `gh-stack-rebase-state`, `gh-stack-modify-state` and
    `gh-stack-migration`;
  - PwrAgent's `pwragent-stack-op.json`.

  PwrGit's own journal is `pwrgit-stack-op.json`, and its undo refs are
  `refs/pwrgit/undo/*`. PwrAgent treats that journal the same way and keeps
  its undo refs under `refs/pwragent/undo/*`.
- An unknown `schemaVersion` drops PwrGit to read-only. PwrGit never rewrites
  a newer format.
- GitLab has no stack object. The same schema goes in
  `$GIT_COMMON_DIR/pwrgit-stack`, and the "link on forge" step is skipped.

Rejected alternatives:

- **`branch.<b>.pwrgitParent` in git config.** Git would carry it through
  `branch -m` and `-d` for free, but gh stack never reads it.
- **PR bases alone.** A branch with no PR yet couldn't be represented.
- **Topology alone.** "Stacked on" can't be told apart from "branched from".

**Inference.** A chain of open PRs, linked base to head, with no catalog entry
becomes an *inferred* stack. PwrAgent's `pullRequestStackOrder()` already
implements this rule and is the reference. An inferred stack is drawn with a
dashed header and offers **Adopt**, which writes the catalog.

**Precedence.** The catalog wins over the forge's PR base. A disagreement is
surfaced as *drift* and is never resolved silently.

## 3. Derived health (per branch)

| State | Rule |
|---|---|
| in sync | `tip(parent) == base` and `base` is an ancestor of the branch |
| needs restack | `tip(parent) != base` |
| parent merged | The forge says the parent's PR is merged. Without a forge, `git cherry <trunk> <parent>` is empty. Ancestry alone is never the test, because squash merges defeat it. |
| needs push | local head ≠ PR `headOid` |
| drift | PR `baseRefName` ≠ catalog parent. On a linked GitHub stack, GitHub owns the bases, so the fix is to unstack and relink, never a PATCH (§4). |
| remote ahead | The remote head isn't the sha PwrGit last fetched or pushed for that branch (the catalog `head` at the last sync, or the PR `headOid`), and isn't contained in the local head. A restack's own rewrite never trips this: the old remote head is expected to stop being an ancestor. PwrGit never force-pushes over a remote that's ahead, lease or not. |

These are pure functions of (catalog, refs, PR list). They live in
`packages/shared` so the renderer, main and MCP compute the same answer.

## 4. The engine

Every operation runs in two phases.

**Plan.** The plan builds a `StackPlan` from the catalog, the refs, and the
operation:

1. For each affected branch, bottom-up, it replays the commits with
   `git replay --onto <new parent tip> <base>..<branch>`. This writes objects
   only. It moves no ref, touches no index or worktree, and runs no hook.
2. If a replay stops, `git merge-tree --write-tree --name-only` walks that
   branch commit by commit. It names the first conflicting commit and its
   files, and that becomes the step's forecast.
3. **Proof.** For each branch, the multiset of `git patch-id --stable` values
   over `base..branch` must equal the multiset over `newParent..newTip`. A
   commit that went empty because trunk already has it is listed in
   `dropped`, never dropped silently. Any other mismatch fails the plan.
4. **Preflight.** For each branch checked out in a worktree, the plan
   intersects that worktree's dirty paths with the paths changed between the
   old and new tip. If the intersection isn't empty, the plan is blocked and
   the files are named.
5. It records `expectedTips` (every ref the plan will move, with its current
   value), the push list, and the forge changes.

**Apply.**

1. It writes `refs/pwrgit/undo/<opId>/<branch>` = old tip for every ref, and
   journals the operation to `$GIT_COMMON_DIR/pwrgit-stack-op.json`.
2. It runs one `git update-ref --stdin` transaction:
   `start`, then `update refs/heads/<b> <new> <expected-old>` for each ref,
   then `prepare` and `commit`. Every ref moves or none does. An expected-old
   mismatch means the plan is stale, and nothing changes.
3. Each checked-out worktree follows with `git read-tree -m -u <old> <new>`.
   That's a two-tree merge that moves the index and files from the old tip to
   the new one and carries local changes along, the way `checkout` does.
   Preflight has already shown it can't refuse. `reset --keep <new>` is wrong
   here: after the transaction, HEAD already points at `<new>`, so it has
   nothing to carry, and the worktree would keep the old tree, which reads as
   the restack undone in `git status`.
4. It updates the catalog (`head`, `base`) under the lock.
5. The forge steps run in a fixed order, described below.

**Why not `rebase --update-refs`.** Git skips refs that are checked out in
another worktree. It warns and carries on, so the stack comes out
half-restacked. In PwrAgent every thread is a worktree, so that's the common
case, not the edge case.

**Conflicts.** A forecast conflict lets the user choose:

- apply the clean branches below the conflict (a smaller transaction);
- resolve: run a real `git rebase --onto` for that one branch in its own
  worktree, or in a disposable worktree if it isn't checked out. The shipped
  `OperationBanner` handles that rebase. When it completes, the rest of the
  plan is re-planned from the resolved tip and applied;
- abort. Nothing has moved, so there's nothing to undo.

**Sync after a merge.** For a merged parent `P` (often squash-merged) with
child `C`:

1. Fetch.
2. Replay `C` with `--onto <trunk> <P's last-known tip>`. P's commits are
   excluded by range, so they're never replayed over their own squash. The
   anchor is the newest of: the catalog `base`, P's last-known tip, and
   `merge-base --fork-point`. The patch-id proof then shows that only C's own
   commits moved. This is the shape of github/gh-stack#586. A regression
   fixture is built from PwrAgent's recorded incident (§8).
3. **Linked GitHub stack: leave the forge alone.** Once a stack is linked,
   GitHub owns its PR bases and retargets C itself. gh stack never PATCHes a
   base on a linked stack, and its `sync` never retargets or deletes branches.
   PwrGit does the same and re-reads the stack (`GET …/stacks`) to confirm.
   **Unlinked stack, or GitLab:** retarget C's PR to trunk *before* anything
   deletes P's remote branch. On GitHub, deleting an open PR's base branch
   closes that PR.
4. Delete local `P`, and its worktree if it's clean and finished, through the
   existing branch-lifecycle guards. The remote branch is left to the forge.

**Submit.**

```
git push --atomic <remote> --force-with-lease=<b>:<expected> <new>:<b> …
```

`--atomic` means GitHub sees all of the pushes or none of them. The lease
always names its expected sha: the last-fetched PR `headOid`, or, for a
branch that has never been pushed, the empty lease
`--force-with-lease=<b>:`, which means "must not exist yet". A bare
`--force-with-lease` trusts a remote-tracking ref that a background fetch may
already have advanced. After the push, Submit:

- opens missing PRs (draft by default) with `base = parent`;
- links or extends the stack object, as gh stack's `submit` and `link` do:
  - `POST /repos/{o}/{r}/stacks` creates a stack from at least 2 PRs, bottom
    to top;
  - `POST /repos/{o}/{r}/stacks/{n}/add` appends. It is append-only;
  - `POST /repos/{o}/{r}/stacks/{n}/unstack` dissolves a stack;
  - `GET /repos/{o}/{r}/stacks` lists stacks. A 404 means the repo has none.
- handles drift by stack state:
  - **Unlinked stack:** retarget drifted bases, then link.
  - **Linked stack:** GitHub owns the bases. A change that isn't an append
    at the top (reorder, move onto, fold, inserting a branch) is planned as
    unstack, then PwrGit retargets the bases while the stack is unlinked, then
    relinks bottom to top. The plan shows all three steps, so nobody is
    surprised that the stack is briefly unlinked.

GitLab: MRs are opened and retargeted, and a managed block in each MR
description lists the stack between
`<!-- pwrgit-stack:start -->` and `<!-- pwrgit-stack:end -->`. No text outside
the markers is touched.

**Undo.**

- Local undo is one transaction back, with expected = the tips Apply wrote.
- Pushed branches get a separate, named "leased push back" step. Undo never
  pushes as a side effect.
- Undo refs expire after 14 days, or 50 operations, through the existing
  repository maintenance.

**Locking.** Locks are taken in this order:

1. the repository lock in `WorktreeOperationQueue`;
2. each affected worktree's lock;
3. `gh-stack-operation.lock`, for the apply window only;
4. `gh-stack.lock`, for the catalog write only.

Each gh stack lock is `LOCK_EX|LOCK_NB`, retried every 100 ms, and gives up
after 5 s, the same budget gh stack uses. A timeout is reported as "gh stack
is running in this clone". It is never forced.

## 5. Operations

| Op | Plan does |
|---|---|
| create branch on top | New branch at the current tip, with `parent` = the current branch. It can carry uncommitted changes, the way `switch-carrying` does. |
| adopt | Writes the catalog for an inferred chain. If a branch isn't on its parent's tip, it is a restack too. |
| restack (from a branch, or all) | Replays each stale branch and everything above it. |
| sync | Fetches, handles merged parents (§4), then restacks. |
| submit | Leased atomic push, open PRs, then link or extend the stack. On a linked stack, any change that isn't an append is unstack, retarget, relink (§4). |
| reorder | Replays in the new order. The live forecast runs while dragging (debounced `merge-tree`). |
| move onto | Reparents a branch and the branches above it onto another branch or trunk. |
| fold | Fast-forwards the parent to the child, deletes the child, and reparents the grandchildren. |
| remove | Detach, which drops the branch's commits from its children, or forget, which is catalog only. |
| merge stack | Linked GitHub stack: one `PUT /repos/{o}/{r}/pulls/{n}/merge-async` merges everything up to PR `n`, with `merge_action` set to `merge_queue` or `direct_merge`. gh stack turns auto-merge off on stacked PRs, and PwrGit doesn't turn it on. Unlinked stack or GitLab: merge bottom-up, with each merge waiting for the previous one to land and sync running between them, through the existing `pr:enqueue` when there is a queue. |

## 6. UI

- **Sidebar.** A Stacks section above Pull requests. Each stack has a spine in
  the lane colour, a dashed segment where a branch isn't on its parent's tip,
  a ⟳ for needs-restack and ↑ for needs-push, a header chip counting the
  stale branches, and trunk last. PR rows get an `n/N` chip that selects the
  stack. The context menu holds New branch on top (⌘⇧N), Restack from here
  (⌘⇧R), Move onto, Fold, Submit stack (⌘⇧P), Sync stack, and Remove from
  stack.
- **Stack view.** Selecting a stack opens it in the main pane, the way a PR
  view opens. It shows cards bottom to top, trunk last, and a Sync / Restack /
  Submit toolbar. The plan panel sits in the right rail: steps, the forecast
  for each, refs moving together, pushes, and forge changes. After a run, the
  same panel becomes the proof ledger.
- **Lineage.** One `n/N` position chip per branch chip. It takes one of the
  two `.ref-chip` slots before `+N`. A gutter bracket selects the stack, and
  the old parent tip is labelled for what it is.
- **Motion.** Cards re-seat in 360 ms on the app's ease-out. The branch being
  replayed carries the amber scanner line. A restacked wire draws solid. Each
  of those is driven by state, none of them bounce, and
  `prefers-reduced-motion` turns them all off.
- **Toasts.** "Restacked 3 branches · Undo". Undo is offered only while the
  operation was local.

## 7. MCP

These are the first `pwrgit_*` tools that write. They're registered in
`packages/mcp-server/src/` the way `app-tools.ts` registers its tools, with
`authorizer.authorize` first and desktop work through an `AppBackend` method.

| Tool | Annotations | Capability |
|---|---|---|
| `pwrgit_stack_list` | read-only | `repository.stack.read` |
| `pwrgit_stack_get` | read-only | `repository.stack.read` |
| `pwrgit_stack_plan` | read-only (objects only) | `repository.stack.read` |
| `pwrgit_stack_apply` | destructive | `repository.stack.write` (+ `repository.stack.publish` for push/forge) |
| `pwrgit_stack_operation` (status/continue/abort/undo) | destructive | `repository.stack.write` |
| `pwrgit_stack_metadata` (adopt/forget/rename, no ref moves) | idempotent | `repository.stack.write` |
| resource `…/stacks` | subscribable | `status.subscribe` |

New capabilities go in `MCP_AGENT_CAPABILITIES` (`packages/shared/src/mcp-policy.ts`):

- `repository.stack.read` is standard;
- `.write` and `.publish` are sensitive.

**Per-operation consent is new.** Without a standing grant, `apply` opens an
approval sheet in the app that renders the same plan, and the tool call waits.
The sheet's buttons are Deny, Local only, and Approve. **Local only** applies
the ref moves and returns the push and forge steps as not done. That's a
partial result, not an error. A session grant can cover `.write` and never
covers `.publish`. This extends `agent-consent.ts` and `consent-broker.ts`;
today they grant only at session start (`docs/desktop-owned-mcp.md`
§Authorization).

`apply` takes `planId` and fails if any `expectedTips` entry moved. That one
check catches a stale plan, a human acting in the UI, and a second agent.

## 8. Tests (AGENTS.md rule 7)

- **Model test.** Random sequences of commit, amend, restack, reorder,
  squash-merge then sync, and undo, run on a temp repo against a pure model
  of the chain. Invariants:
  - every parent tip is an ancestor of its child after a restack;
  - per-branch patch-id multisets are preserved;
  - undo restores exact tips;
  - nothing reachable before becomes unreachable from `refs/pwrgit/undo`.
- **Oracle.** On identical fixtures, `gh stack rebase` and PwrGit's restack
  produce the same trees. A catalog PwrGit wrote reads back unchanged through
  `gh stack view --json`. This runs only where the extension is installed,
  and is skipped elsewhere with a visible reason.
- **Forecast soundness (property).** If the forecast says clean, apply doesn't
  conflict. If it names files, those are the files `rebase --onto` stops on.
- **Interop.** These tests are shared with PwrAgent's copy of the engine:
  - A catalog edited by gh stack, PwrGit and PwrAgent in turn keeps every
    stack.
  - A hash mismatch makes the writer redo its edit, never overwrite.
  - A held `gh-stack-operation.lock` or `gh-stack.lock` times out at 5 s
    without forcing.
  - Each journal (`gh-stack-rebase-state`, `gh-stack-modify-state`,
    `gh-stack-migration`, `pwragent-stack-op.json`) blocks every mutation.
- **Regression.** The gh-stack #586 shape syncs with zero conflicts. Confirm
  the test fails against a naive `rebase origin/main`.
- **Atomicity.** Fault injection between `prepare` and `commit`, and a
  concurrent ref move, both leave every ref at its old value.

## 9. Phasing

| Phase | Ships | Gate |
|---|---|---|
| P0 | Catalog reader, inference, health, Stacks section, position chips, read MCP tools, stacks resource | Read-only |
| P1 | Restack, worktree follow, proofs, undo, new branch on top, adopt, remove | Model and atomicity tests |
| P2 | Submit (create, add, unstack and relink the stack object), sync after merge, GitLab managed block | Oracle, interop and #586 regression |
| P3 | Reorder with live forecast, fold, move onto, MCP plan/apply with consent sheet, merge stack (`merge-async`) | Forecast property test |

## 10. Open questions

1. *Resolved* (gh stack v0.3.0 `2a49e67`, via PwrAgent#4190): the locks,
   compare-and-swap catalog writes and journals described in §2.
2. *Resolved* (same source): the stack object API, GitHub owning the bases of
   a linked stack, and `merge-async` (§4, §5).
3. Whether a stack that spans two remotes (a fork's CI PR plus the upstream
   PR) is one stack or two. The proposal is one, keyed by the upstream PRs.
