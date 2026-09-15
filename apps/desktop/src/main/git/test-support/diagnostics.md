# Git timeout investigation

The five-second threshold is a diagnostic trigger for small local fixtures. It
does not fail a test, stop Git, change Vitest timeouts, or alter pipe draining.
The app does not enable the diagnostic scope. The Vitest setup enables it for
`src/main/git` suites, including their shared system-Git helper and calls through
the text, binary, and streamed-record Dugite adapters.

## Reading the reports

`[git-diagnostic]` lines contain JSON. Reports and call journals are appended
immediately to worker-specific JSONL files under `test-results/git-diagnostics`
locally, or `PWRGIT_GIT_DIAGNOSTICS_DIR` when set. Existing
Linux and Windows unit-test CI jobs upload that directory even on failure.
The controlled fixtures also write their reports there on successful runs.

`calls-*.jsonl` contains compact `scope-begin`, `stage`, `call-begin`, `call-end`,
and `scope-end` records, including fast calls. `call-begin` is appended before
the actual invocation. `call-end` follows return/throw; `scope-end` contains the
whole test's accounting, not only the last 12 calls. Boundaries are not printed
to stderr during normal fast execution. Each journal has one writer.

`watchdog-*.jsonl` is written by an independent JavaScript worker, started and
awaited before fixtures in `remote.test.ts` and `partial-staging.test.ts`. It
can record elapsed test time, the last known stage, cumulative command totals,
outstanding synchronous calls, and bounded OS process samples while the test's
thread is blocked in `execFileSync`. It uses a separate file because worker
stdout is forwarded through the parent thread. Optional stderr notifications
may therefore arrive later than the persisted observations.

Each invocation has a worker/PID-local ID, a source, an allowlisted Git command,
argument count, hashed repository cwd, and native cwd category. Reports omit
arguments, environment, output, error messages, and raw paths. Monotonic offsets
are relative to invocation start; `slow-test` elapsed time is relative to test
start. A test ID correlates reports without exporting test parameter values.
Call-journal `monotonicMs` and watchdog `observedMonotonicMs` share the process's
`hrtime` clock across threads. They are not wall-clock log timestamps.

| Evidence | What it establishes |
| --- | --- |
| No `exit`, `exitCode: null`, `terminationObserved: false` | The observer has not received termination; inspect the OS sample before assuming the process is still alive. |
| `exit` with a code/signal, stdout/stderr not ended, promise pending | The direct child exited while output streams remain open. This does not identify the pipe owner. |
| `child-close`, then `promise-resolved`/`promise-rejected` | The pipe/child lifecycle and the observed promise completed. |
| `killed: true` | Node reports that a signal was sent, not that the child terminated. |
| Large `timerLatenessMs` | The diagnostic callback ran late. Scheduling pressure, synchronous work and event-loop starvation remain possible explanations. |
| `slow-settlement-before-timer` | Work exceeded the threshold but settled before the timer callback ran. Timer lateness is unknown, not zero. |
| `helper-flush-grace-expired` | The existing system-helper 250ms drain cutoff was reached. The snapshot precedes stream destruction. |
| Slow test with no active Git | Inspect the last 12 calls; cumulative Git cost or non-Git work may explain the delay. |
| `aggregate` / `bySource` / `byCommand` | Started/completed/rejected call counts, summed completed-call duration, and maximum completed-call duration. Concurrent durations can overlap; their sum is not test wall time. Only instrumented calls are counted. |
| `stages` | Wall time and command accounting for setup, operation, verification and cleanup where explicitly marked. Repeated stages accumulate; asynchronous calls are attributed to the stage in which they started. |
| `independent-slow-sync-call` | A begin record has no received end record past its threshold. No ChildProcess exit, pipe state or child PID is implied. OS ancestry is separate evidence. |
| `lastRecordAgeMs` / `observerLatenessMs` | Age of the latest record and lateness of the independent observer, exposing its own scheduling/message delays rather than attributing all delay to the test thread. |

Byte counts are measured by existing consumers. Dugite binary execution observes
execFile's already-flowing data events without another read/pipe/resume operation.
For decoded strings, counts are the UTF-8 byte length of delivered text, not a
claim about undecodable raw bytes. Both output streams include last-activity
offsets, readable state and buffer length; stdin includes writable state. Error
observation uses Node's `errorMonitor`, preserving unhandled-error behavior.
For synchronous execution, stream state, output byte counts and observed
termination are `null` (unknown), not zero/false measurements.

Timers are unreferenced and canceled on settlement/scope cleanup. Listeners are
removed on close or, when a promise settles before close, after a bounded one-second
observation window. Test completion disposes pending diagnostics without killing
the corresponding Git process. It retains ordinary runner and helper cleanup.
The independent worker is unreferenced. Suite teardown stops its interval and
sampler and awaits worker exit, with a bounded termination fallback. The worker
never signals an observed Git process. Journaling adds filesystem/message
overhead to test execution; it does not introduce a new Git completion deadline.

OS samples run only after slow triggers: `ps` on macOS/Linux and PowerShell CIM
on Windows, with a 1.5-second deadline, 512 KiB capture bound, and at most 64
numeric process relationships. No command lines are requested. Samples may be
unavailable, canceled when observation ends, or incomplete after reparenting;
they cannot reliably attribute a detached pipe holder after its parent exits.

All synchronous Git call sites in `remote.test.ts` and `partial-staging.test.ts`
are instrumented, including expected-error and binary fixture reads. The three
historically implicated tests also mark setup/operation/verification stages.
Synchronous calls elsewhere remain outside this accounting unless wrapped.
The test's own thread cannot report during a blocking call; the independent
watchdog can. A starved watchdog, filesystem failure, or abruptly killed process
can still leave only earlier records. Missing end records alone do not prove
Git is alive, and OS ancestry does not identify inherited-pipe owners.

## Evidence available before this change

The Windows logs at Node 24.20.0 confirm:

- [Run 34768641007](https://github.com/pwrdrvr/PwrGit/actions/runs/34768641007/job/103754188585):
  `remote.test.ts` partial-merge recovery timed out at 20 seconds.
- [Run 34765618543](https://github.com/pwrdrvr/PwrGit/actions/runs/34765618543/job/103745974732):
  partial staging timed out at 20 seconds and indexed-stash recovery at 15
  seconds. The partial-staging cleanup also reported EPERM removing its fixture.

Those logs contain no spawn/exit/pipe timeline. EPERM does not identify a lock
owner. Neither inherited-pipe causality, a Windows launcher defect, nor a Node
regression is established by these failures.

[PR #261](https://github.com/pwrdrvr/PwrGit/pull/261) subsequently centralized the
test helper and introduced its 250ms post-exit grace. This investigation preserves
that behavior and makes expiry visible. A controlled fixture demonstrates that
the policy can discard output written later by a detached descendant; it does
not establish that any historical test lost output. Production Dugite completion
policy is unchanged, and neither Dugite nor PwrAgent is modified.

The 12 most recent CI runs inspected on 2026-09-14 had nine successful completed
runs, one failed completed run, and two unfinished runs. The failed completed run
[34882418186](https://github.com/pwrdrvr/PwrGit/actions/runs/34882418186) had passing
Linux/Windows unit-test jobs and failures in desktop E2E jobs. This bounded sample
does not prove the intermittent unit-test timeout is fixed.

## Local validation

macOS arm64, Node 24.21.0:

- Controlled Git waiting on open stdin: slow snapshot had no exit and an open
  writable stdin; the bounded OS sampler returned. Closing stdin completed Git.
- Real Git invoking a detached pipe holder: exit code 0 preceded stdout/stderr
  end; raw close-based collection and Dugite text/binary promises stayed pending
  until the release handshake. Late output was retained completely.
- Existing system-helper grace: expiry was reported at about 309ms from
  invocation in one sample, with Git exited and both streams still open.
- Controlled 100ms event-loop block against a 30ms trigger: callback lateness
  was about 70ms. This validates the measurement, not a CI starvation hypothesis.
- Fast completion, pending-scope disposal, paused stream/error behavior, spawn
  failure, redaction, and integration through all Git adapters are asserted.
- `remote`, `partial-staging`, `dugite`, and `rebase-assistant`: 100 tests passed.
  Three additional repetitions of `remote` + `partial-staging`: 79 tests each
  passed, with no five-second reports or grace-expiry reports in those real suites.

Example local invocation (after normal repository setup):

```sh
PWRGIT_GIT_DIAGNOSTICS_DIR=/tmp/pwrgit-git-diagnostics pnpm test \
  apps/desktop/src/main/git/git-diagnostics.test.ts \
  apps/desktop/src/main/git/remote.test.ts \
  apps/desktop/src/main/git/partial-staging.test.ts
```

Controlled tests use shorter observation thresholds and explicit readiness/release
handshakes. They do not lower normal test deadlines or change production timing.

Additional synchronous coverage uses a real Git alias whose child waits for the
independent watchdog's persisted OS sample and slow-call report before it can
exit. Assertions verify that those records predate the main thread's call-end
and that its own timer did not run during the call. A separate check runs 38
actual synchronous `git --version` calls: all begin/end pairs and aggregate totals
survive the 12-call recent-history bound, with test-level reporting even though
no individual command reaches the five-second operation threshold. Fast return,
exception identity, redaction, and worker/timer cleanup are also checked.

One local follow-up sample of the actual PwrGit arbitrary-line staging test
recorded 101 Git calls (13 in setup, 80 in the operation, 8 in verification),
732ms summed command time and a 15ms maximum call, within 772ms of measured test
scope time. The marked remote recovery tests recorded 37 and 27 calls. These
are local accounting observations, not explanations of historical Windows
failures. They demonstrate how a modest per-command slowdown can accumulate
without any single call crossing five seconds.
