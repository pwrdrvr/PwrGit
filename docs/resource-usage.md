# Investigating long-running CPU and energy use

PwrGit writes one resource sample per minute to the `resources` subdirectory
of its log directory (`~/Library/Logs/PwrGit/resources` on macOS). No switch or
profiling session is needed. UTC hourly NDJSON files retain the last 24 hours
plus the current hour. Existing `main.log` still records individual operations.

After leaving the build running through the workload of interest, summarize
the last 12 hours from the repository root:

```sh
node apps/desktop/scripts/resource-usage-report.mjs ~/Library/Logs/PwrGit/resources
```

The optional second argument changes the hours. The report separates app
sessions by main-process PID and start time and groups Git processes by origin
and subcommand.
The samples also record window focus, visible-window count and battery power,
so their timelines can be compared with automatic pulls and Activity Monitor.
Only fixed labels and numeric counters are recorded: no command arguments,
repository paths, refs, remote URLs, environment or command output.

- Electron CPU seconds are differences between cumulative process counters,
  independently of other callers of `getAppMetrics`. New helpers contribute
  their lifetime CPU since creation. Helpers that start and exit between
  samples are not included, and unsupported counters are `null`, not zero.
- Git counts observe actual subprocess spawns from the text, binary and
  record-stream adapters. Their labels identify bulk fetch/pull (including
  post-sync indexing and state refresh), active/visible refresh, remote-tip
  checks, authored sweeps and root discovery. Other paths are `other`. These
  counts do not include Git's own descendants or forge CLI subprocesses.
- Git `wallMs` is the sum of completed subprocess lifetimes, charged to the
  interval in which each process closes. It includes network waits, overlapping
  processes and child-pipe drain time. It is **not CPU time**. `active` and
  `peak` include subprocesses that span intervals; `nonzero` includes normal
  negative probes, such as an absent upstream or a false ancestor test.
- A delayed timer (including system sleep) records its actual wall-clock
  interval. Nothing wakes the computer to collect samples. The last partial
  minute and writes still pending on exit can be absent.

This measures workload, not watts or macOS's Energy Impact score. Compare
similar workloads before and after a change; use Activity Monitor or an OS
energy trace to validate power savings. The existing hot-CPU profiler remains
useful for sustained JavaScript load, whereas these counters capture short,
repeated subprocess bursts over a day.

## Initial investigation, November 15, 2026

The reported screenshot showed instantaneous Energy Impact 0.2 and 12-hour
Power 828.07 for PwrGit. The installed app was version 0.59.3. Its retained
logs showed profile-wide soft pulls roughly every five minutes across 27
repositories. Twelve fully logged runs between 16:52 and 17:57 lasted
25.336–45.229 seconds, median 32.9815 seconds. These are elapsed durations,
not CPU or energy measurements. The indexed inventory contained 181
repositories and 520 worktrees across profiles; PwrAgnt alone had 80 worktrees.

Every successful bulk fetch currently refreshes the repository's full worktree
state, even when its refs did not change. A state computation reads status,
recent authored history, identity, default-branch relationships and possibly
fork-source relationships. The old/current logs contained over 13,000
nonzero Git debug records across their retained portions; successful probes
were not logged there. This identifies repeated work but does not establish
its share of the 12-hour energy total.

Production code does not explicitly disable App Nap, disable Chromium
background throttling, or request a power-save blocker. Activity Monitor's
App Nap value alone does not establish why the OS has not napped an app.
The installed app's Info.plist and preferences had no `NSAppSleepDisabled`
override, and `pmset -g assertions` showed no assertion owned by PwrGit at
the time of inspection.
Electron documents background throttling as enabled by default:
<https://www.electronjs.org/docs/latest/api/browser-window>.

The next optimization candidates are avoiding full post-fetch recomputation
when Git state is unchanged, sharing repeated history queries across sibling
worktrees, and reducing offscreen/background work. Those require validating
freshness, external Git operations, configuration changes and pull safety;
this instrumentation establishes a comparable baseline first.
