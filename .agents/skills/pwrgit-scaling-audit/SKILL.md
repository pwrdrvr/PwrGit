---
name: pwrgit-scaling-audit
description: >-
  Find quadratic work and fanout in PwrGit with local model-based tests and
  scaling probes. Use for changes whose cost grows with repositories, worktrees,
  remotes, refs, history, or renderer refreshes and event bursts.
---

# PwrGit Scaling Audit

Trace the affected workflow from its normal entry point through Git, forge calls,
SQLite, IPC, and the renderer where involved. Count work over the full action,
including deferred refreshes and renderer updates. A linear tree rebuild on each
event can still cost `O(events × rows)` over a burst.

## Identify the dimensions and expected work

State what grows, what work to count, and what bound the action should meet. For
linked worktrees, distinguish repository-wide work from checkout-specific work.
Choose the paths and counters that match the change.

| Path | Workloads and counters to consider |
| --- | --- |
| Git and bulk sync | Vary repositories, linked worktrees, remotes, refs, and concurrent refreshes. Count Git process starts by repository or checkout and refs visited. Include unchanged remotes, moved tips, and overlapping callers. |
| Forge status | Vary repositories, remotes, branches, PRs or MRs, pages, and poll cycles. Count provider requests, pages, retries, and status rows rebuilt. Check whether a single PR update refreshes unrelated repositories. |
| Repository discovery and indexing | Vary roots, repositories, worktrees, and watcher bursts. Count directories visited, Git probes, SQLite queries and rows rewritten, and IPC messages. Compare cold discovery with a no-op rescan and a single changed checkout. |
| Lineage and history | Vary commits loaded, refs per commit, graph shape, and refresh or pagination cycles. Count Git calls, data sent over IPC, rows rebuilt, and layout reads. Compare an equivalent refresh, a moved ref, and a new commit or page. |
| Sidebar and bulk progress | Vary visible and total repository rows, expanded sections, and progress or `repo:changed` events. Count tree reads, unchanged row references replaced, React commits, and layout or paint work. Exercise single events and bursts in collapsed and expanded views. |

## Probe the same path two ways

1. **Explore with model-based testing.** Use Vitest and fast-check as described in
   the [property, model and oracle testing guide](../../../docs/property-model-oracle-testing.md).
   Generate valid action sequences and compare state to Git plumbing in temporary
   repositories, a simple reference model, or the expected forge response order.
   Assert work counts after each action where practical. Vary ordering, cache
   invalidation, and overlapping calls that the entry point can see. Use seeded
   local runs, up to 1,000 variations when cheap enough, and force some cases to
   reach the target size and state. Use fakes for high-volume I/O and confirm a
   reduced case at the real boundary. Record the seed and shrink path or the exact
   failing sequence and dimensions. Keep exploratory harnesses, raised run counts,
   and bulk output out of commits and CI.
2. **Measure growth with controlled inputs.** Run the same workload at `n`, `2n`,
   and `4n`, or comparable sizes that expose the cost. For two dimensions, vary
   each independently and then grow both together. Hold other inputs and cache
   conditions steady within each series and compare cold, warm, and invalidated
   cases where relevant. Count work where it happens, such as Git starts after
   queueing, provider requests after caching, or renderer commits after IPC. Use
   repeated timings or profiles when work is opaque, such as Chromium layout and
   paint. Repeat the same probes on the pre-fix and fixed paths.

The [bulk pull preflight property tests](../../../apps/desktop/src/main/git/bulk-sync-preflight.property.test.ts)
compare Git state and count subprocess work. The [repository tree coalescing tests](../../../apps/desktop/src/renderer/src/state/useRepoTree.coalescing.property.test.tsx)
check targeted `repo:changed` bursts and unchanged row references. For renderer measurements,
the [Lineage refresh benchmark](../../../apps/desktop/e2e/graph-refresh-benchmark.spec.ts)
uses the hidden harness. Follow the [PwrSuiteLab procedure](../../../docs/headed-e2e-pwrsuitelab.md)
when a probe requires visible Electron E2E.

## Fix and keep the regression small

- Fix reproduced, in-scope work at its source. Batch shared work at its owning
  repository or remote, keep checkout-specific decisions scoped to the checkout,
  and preserve unchanged renderer rows where possible. Recheck ordering,
  deduplication, freshness, and targets affected by invalidation.
- Reduce each finding to a named counterexample and a cheap deterministic work
  assertion that fails before the fix and passes after it. Examples include Git
  starts per bulk run, forge requests per poll, and tree reads per change burst.
  Keep generated tests within the [repository's CI budget](../../../docs/property-model-oracle-testing.md#how-to-write-them).
  Use operation counts where they can replace timing thresholds.
- Report the measured path, dimensions and cache conditions, before and after
  counts or growth, and the regression tests kept. If a suspected cliff did not
  reproduce, report the workload exercised.
