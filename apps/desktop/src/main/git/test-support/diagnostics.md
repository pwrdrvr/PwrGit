# Git timeout investigation

The five-second threshold is a diagnostic trigger for small local fixtures. It
does not fail a test, stop Git, change Vitest timeouts, or alter pipe draining.
The app does not enable the diagnostic scope. The Vitest setup enables it for
`src/main/git` suites, including their shared system-Git helper and calls through
the text, binary, and streamed-record Dugite adapters.

## Reading the reports

`[git-diagnostic]` lines contain JSON. With `PWRGIT_GIT_DIAGNOSTICS_DIR` set, the
same reports are appended immediately to worker-specific JSONL files. Existing
Linux and Windows unit-test CI jobs upload that directory even on failure.
The controlled fixtures also write their reports there on successful runs.

Each invocation has a worker/PID-local ID, a source, an allowlisted Git command,
argument count, hashed repository cwd, and native cwd category. Reports omit
arguments, environment, output, error messages, and raw paths. Monotonic offsets
are relative to invocation start; `slow-test` elapsed time is relative to test
start. A test ID correlates reports without exporting test parameter values.

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

Byte counts are measured by existing consumers. Dugite binary execution observes
execFile's already-flowing data events without another read/pipe/resume operation.
For decoded strings, counts are the UTF-8 byte length of delivered text, not a
claim about undecodable raw bytes. Both output streams include last-activity
offsets, readable state and buffer length; stdin includes writable state. Error
observation uses Node's `errorMonitor`, preserving unhandled-error behavior.

Timers are unreferenced and canceled on settlement/scope cleanup. Listeners are
removed on close or, when a promise settles before close, after a bounded one-second
observation window. Test completion disposes pending diagnostics without killing
the corresponding Git process. It retains ordinary runner and helper cleanup.

OS samples run only after slow triggers: `ps` on macOS/Linux and PowerShell CIM
on Windows, with a 1.5-second deadline, 512 KiB capture bound, and at most 64
numeric process relationships. No command lines are requested. Samples may be
unavailable, canceled when observation ends, or incomplete after reparenting;
they cannot reliably attribute a detached pipe holder after its parent exits.

Synchronous fixture helpers in `remote.test.ts` and `partial-staging.test.ts`
report duration after returning. JavaScript cannot emit a new diagnostic while
its thread is blocked indefinitely. An abruptly terminated worker may leave
only earlier snapshots. The harness does not claim to solve that limitation.

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
