# Stacked pull requests: model, operations, UI and MCP

Status: proposed. Nothing here is built. The board is
[`design/Stacked PRs - UX Review.dc.html`](../../design/Stacked%20PRs%20-%20UX%20Review.dc.html),
which is also live on the PwrGit design canvas. It has a working prototype of
every operation in turn 3.

Scope: stack state, the stack engine (restack, sync, submit, reorder), the
Stacks sidebar section, the stack view, lineage-graph annotations, undo, and
the first write tools on PwrGit's MCP server. PwrAgent builds its
agent-managed stacks on this. That is designed separately, in that repository.

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

Rules:

- Writes are made under `gh-stack.lock`, taken the way gh stack takes it.
  Confirm the mechanism in v0.3.0's source before P1. While
  `gh-stack-operation.lock` or a gh stack recovery journal is active, every
  stack operation is refused with "gh stack is mid-operation in this clone".
- An unknown `schemaVersion` drops PwrGit to read-only. PwrGit never rewrites
  a newer format.
- Writes are read-modify-write of only the stack being changed. Unrelated
  stacks in the same file are kept byte-for-byte where possible.
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
| drift | PR `baseRefName` ≠ catalog parent |
| remote ahead | The remote head isn't an ancestor of the local head. PwrGit never force-pushes over this, lease or not. |

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
3. Each checked-out worktree follows with `git reset --keep <new>`. Preflight
   has already shown this can't refuse.
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
3. **Retarget C's PR to trunk before anything deletes P's branch.** On GitHub,
   deleting an open PR's base branch closes that PR.
4. Delete local `P`, and its worktree if it's clean and finished, through the
   existing branch-lifecycle guards.
5. Update the stack object on the forge.

**Submit.**

```
git push --atomic <remote> --force-with-lease=<b>:<expected> <new>:<b> …
```

`--atomic` means GitHub sees all of the pushes or none of them. The lease
always names its expected sha (the last-fetched PR `headOid`). A bare
`--force-with-lease` trusts a remote-tracking ref that a background fetch may
already have advanced. After the push, Submit:

- opens missing PRs (draft by default) with `base = parent`;
- retargets drifted bases;
- links the stack object. Use the same API gh stack's `submit` and `link` use,
  and pin the endpoint from v0.3.0's source before P2.

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
3. `gh-stack.lock` (catalog writes only).

## 5. Operations

| Op | Plan does |
|---|---|
| create branch on top | New branch at the current tip, with `parent` = the current branch. It can carry uncommitted changes, the way `switch-carrying` does. |
| adopt | Writes the catalog for an inferred chain. If a branch isn't on its parent's tip, it is a restack too. |
| restack (from a branch, or all) | Replays each stale branch and everything above it. |
| sync | Fetches, handles merged parents (§4), then restacks. |
| submit | Leased atomic push, open or retarget PRs, link the stack. |
| reorder | Replays in the new order. The live forecast runs while dragging (debounced `merge-tree`). |
| move onto | Reparents a branch and the branches above it onto another branch or trunk. |
| fold | Fast-forwards the parent to the child, deletes the child, and reparents the grandchildren. |
| remove | Detach, which drops the branch's commits from its children, or forget, which is catalog only. |
| merge stack | Merges bottom-up. Each merge waits for the previous one to land, and sync runs between them. Merge-queue aware via the existing `pr:enqueue`. |

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
- **Regression.** The gh-stack #586 shape syncs with zero conflicts. Confirm
  the test fails against a naive `rebase origin/main`.
- **Atomicity.** Fault injection between `prepare` and `commit`, and a
  concurrent ref move, both leave every ref at its old value.

## 9. Phasing

| Phase | Ships | Gate |
|---|---|---|
| P0 | Catalog reader, inference, health, Stacks section, position chips, read MCP tools, stacks resource | Read-only |
| P1 | Restack, worktree follow, proofs, undo, new branch on top, adopt, remove | Model and atomicity tests |
| P2 | Submit, sync after merge, GitLab managed block | Oracle and #586 regression; stack-object endpoint pinned |
| P3 | Reorder with live forecast, fold, move onto, MCP plan/apply with consent sheet, merge stack | Forecast property test |

## 10. Open questions

1. The exact locking protocol behind `gh-stack.lock` and
   `gh-stack-operation.lock`, and where v0.3.0 writes its recovery journal.
2. The GitHub API behind the stack object (`gh stack link`), and whether it is
   generally available or in preview for the org.
3. Whether a stack that spans two remotes (a fork's CI PR plus the upstream
   PR) is one stack or two. The proposal is one, keyed by the upstream PRs.
