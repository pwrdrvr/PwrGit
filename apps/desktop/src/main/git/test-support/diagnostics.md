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

## PR #270 follow-up: which process owns an open pipe?

The rebased head `79cbef9c` passed [CI run 34919930475](https://github.com/pwrdrvr/PwrGit/actions/runs/34919930475).
Its [Windows artifact](https://github.com/pwrdrvr/PwrGit/actions/runs/34919930475/artifacts/10378025823)
contains these **real test** observations (controlled fixtures excluded):

| Observation | Measured evidence |
| --- | --- |
| Partial-merge recovery | 37 calls; 11,608ms test scope; 11,575ms summed command time; slowest synchronous setup clone 5,904ms |
| Arbitrary-line staging | 101 calls; 5,124ms scope; 4,942ms summed command time; slowest call 137ms |
| Branch call `6924-646`, PID 6004 | Exit 0 at 43.342ms; helper grace expired at 306.266ms; stdout 5 bytes, stderr 0; neither stream had emitted end; both buffers empty |

The branch record is task `1683180523_0_30` in `remote.test.ts`, mapped with
Vitest's collected test list to **“keeps a local merge commit that range-diff
omits.”** Counting textual `it(` declarations is insufficient because some
declarations span multiple lines. The exact helper invocation is
`git -C <fixture> branch --show-current`, through `resolveCheckedOutRef` in
`git-service.ts`, with the native cwd set to the OS temporary directory.
The test creates a bare origin and two ordinary clones, commits text files,
fetches and makes a local `--no-ff` merge, advances the remote, then calls
`pullFastForward` and `inspectRemoteDivergence`. It configures fixture user
name/email, but no LFS attributes, hooks, filters or fsmonitor. Inherited runner
configuration was not captured in that run.

The record establishes **exit before Node stream-end events**, not a live writer,
its identity, or natural EOF timing: the existing helper destroyed its streams
at grace expiry. A queued/unprocessed EOF under load remains possible. Neither
the launcher, LFS, nor another helper can be identified from that old artifact.

The opt-in `PWRGIT_GIT_PIPE_OWNERSHIP=1` follow-up adds:

- Sanitized [Git Trace2](https://git-scm.com/docs/api-trace2) for the exact branch
  operation in `remote.test.ts`: session PID chains, executable identity,
  `child_start`/`child_exit`/`child_ready`, exec, exit, config scope and presence.
  Child IDs correlate start/exit; a child exit PID of -1 denotes a failed spawn,
  not a process that ran. Only a fixed set of hooks/fsmonitor/LFS/pager/cache/auto
  maintenance keys is requested. Non-boolean config values and arbitrary command
  identities are hashed. A short Git-specific environment allowlist records
  only which keys exist, never their values. Presence of LFS configuration is not evidence of LFS
  execution; missing Trace2 events do not rule out an uninstrumented launcher.
- On Windows, a small observer compiled with the installed PowerShell framework
  compiler subscribes to process start/stop events **before** the suite starts
  spawning Git. It preserves PID/parent/binary events, event UTC, observer
  monotonic time, and queried executable identity when still accessible. This
  preserves ancestry across parent exit, subject to explicit subscription,
  access, cache and PID-reuse limitations. Known Git installation suffixes
  distinguish `Git/cmd/git.exe` from `Git/mingw64/bin/git.exe`; arbitrary paths
  and process command lines are never uploaded.
- Bounded handle samples at spawn in the implicated test and at helper grace
  expiry. These are asynchronous requests: a sample may arrive after the helper
  has already destroyed its streams. Samples include their observation time;
  a request's call ID alone does not prove a pipe belongs to that invocation.
  Matching is strongest in the separate controlled probe, where a before-spawn
  baseline identifies the new parent endpoints.

Handle inspection is an experiment, not a supported Windows ownership oracle.
It enumerates the native extended handle table (bounded to 32MiB), duplicates
only handles from the root and up to 64 observed descendants/explicit target,
and queries names only for `FILE_TYPE_PIPE`. Pipe names and kernel object
identities are hashed. It uses `NtQueryObject(ObjectNameInformation)` because
[GetFileInformationByHandleEx explicitly excludes pipe handles](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).
Native interfaces can change, require access the runner lacks, or block. Each
inspection has a 500ms scan budget, a 900ms parent deadline and a separate 1.5s
self-exit timer; all duplicated handles close on inspector exit. The observer
has a ten-minute maximum lifetime. Capability failures are artifact records,
not proof that no writer exists. Process start/stop caches are bounded and
pruning is explicitly reported.

The meaningful positive match is a **new parent pipe ID** also held by the known
living holder, with an **opposite client/server endpoint and write access**.
Write access alone is insufficient because Node's own endpoint can be duplex.
Client/server PID APIs describe pipe endpoints, not every inheriting owner;
the owner PID here comes from the enumerated handle table. An empty result
cannot exclude inaccessible processes, missed ancestry, or a pipe that closed
before sampling. Duplicating a writer handle can itself extend pipe lifetime;
inspected timing is explicitly labeled and kept separate from uninspected runs.
Handle-table enumeration and subsequent queries are not an atomic snapshot.

### Separate natural-EOF experiment

`test-support/pipe-ownership-probe.cjs` reconstructs the plain merge history and
runs 64 branch invocations through a dedicated close-based collector, followed
by two readiness/release-controlled Git alias cases with a detached Node holder.
The first holder run requests no handles; the second requests before/after
samples and reports whether ownership was actually established. Both wait for
natural EOF after releasing the holder. Only this separate experiment has a
ten-second cleanup deadline; deadline closures are labeled forced and fail its
natural-completion assertion. This does not change test-runner deadlines,
`system-git.ts`'s 250ms grace, or production Dugite completion.

Both existing CI test jobs run the probe and upload sanitized `ownership-*`
directories with the other Git diagnostics, including on failure. Raw Trace2
is written outside the upload tree, read with a 1MiB per-call limit, sanitized
at exit/settlement and removed on normal session close. If a worker is forcibly
terminated, its private temporary files are still outside the uploaded tree.

Local macOS/Node 24 validation: 64 branch calls all completed naturally, with
maximum exit-to-close time 4.919ms and none pending at 250ms. The two known
holder controls had about 1,808ms and 1,814ms exit-to-close delay and returned
all 32 expected stdout bytes. Windows handle inspection is unavailable on that
host; these numbers establish lifecycle behavior, not Windows ownership.
The 119 focused tests and repository lint passed; an additional ownership-match
test rejects same-endpoint duplex handles, pre-existing pipes, wrong owners and
handles without write access. The observer source also
compiled as C# 5 against .NET 9/System.Management references; that is syntax/API
reference validation, not a test of Windows PowerShell or native API behavior.

### Results from the first ownership-instrumented Windows run

Head `029ded6e` passed [CI run 34932156444](https://github.com/pwrdrvr/PwrGit/actions/runs/34932156444).
The [Windows artifact](https://github.com/pwrdrvr/PwrGit/actions/runs/34932156444/artifacts/10381943373)
contains 35 real remote-suite branch traces and 64 separate branch probes. None
of those branch traces recorded a Git `child_start`, despite system-scope LFS
filter configuration being present. There were no real helper grace expiries
or five-second individual-Git reports. Ten real Windows tests emitted finish
reports; Linux had no real slow reports.

The exact previously implicated test now used launcher PID 9364 and Trace2 Git
PID 9888; WMI records the parent relation 9364 → 9888. Git exited at about 85ms
and the helper settled at about 88ms. This is a successful sample, not a
reproduction of the earlier missing-EOF condition. The standalone Windows
branch probes had maximum exit-to-close time 3.959ms (Linux: 2.414ms).

The first standalone Windows branch recorded `Git/bin/git.exe` PID 5044,
`Git/mingw64/bin/git.exe` PID 5888, and a console host PID 1792. The console
host's name was hashed by the initial allowlist; its hash matches `conhost.exe`.
That name is now explicitly allowed. The command closed normally, so this
identifies an additional process but does not implicate it as a retained writer.
The controlled detached-holder cases identify Node PIDs 7724 and 9292, and
closed naturally about 1.835s and 1.822s after Git exit, following release.

Windows PowerShell compilation and process subscriptions succeeded. All three
handle inspections (the real spawn sample and the control's baseline/post-exit
samples) hit the 900ms inspector deadline. No handle ownership match was
established. That version discarded partial inspector output on timeout, so
it cannot establish whether startup, table enumeration or a particular native
query consumed the deadline. The follow-up preserves bounded JSONL progress
through those stages and completed handle records even on timeout, without
extending any deadline. Matching also requires a complete successful baseline:
a missing/partial baseline cannot make later handles count as new pipes.

WMI timestamps have a material observed limitation: the first standalone Git
wrapper's stop notification is timestamped around `05:23:21.876Z`, although
Node had already observed exit and natural close about 0.8s earlier. WMI
`TIME_CREATED` is therefore labeled as a provider-event clock, **not a kernel
process-exit clock**. Registration before Git starts preserves available
parent/binary events, but delayed provider notifications do not prove a process
was still alive until that timestamp. PID reuse also requires temporal context;
joining every occurrence of a PID across the entire suite fabricates lineage.
