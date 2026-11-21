# Investigating long-running CPU and energy use

Resource recording is **off by default**. Enable **Settings → Troubleshooting
→ Resource Usage Recording → Record resource usage for 24 hours** for a
representative session. It starts live, independently of heap/CPU profiling,
and turns itself off 24 hours after it was turned on. The stop time is stored
with the setting, so a restart continues the same recording instead of
starting a new day; Settings shows when it stops. Turning it off early stops
it immediately. A setting saved by an older build (on, with no stop time) is
given 24 hours from the first launch that reads it.
When off, it does not sample processes, retain Git counters, create a timer,
or write resource files. Nothing is uploaded automatically.

When enabled, PwrGit writes one sample per minute to `resources` under the
diagnostics folder shown at the top of Troubleshooting (`~/Library/Application
Support/PwrGit/diagnostics/resources` on macOS). UTC hourly NDJSON files retain
the last 24 hours plus the current hour. Existing `main.log` still records
individual operations. When recording stops, by expiry or by hand, existing
files remain available for inspection; older files are pruned only when a
later recording writes.

After leaving the build running through the workload of interest, summarize
the last 12 hours from the repository root:

```sh
node apps/desktop/scripts/resource-usage-report.mjs "$HOME/Library/Application Support/PwrGit/diagnostics/resources"
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

## Bulk-pull change detection

Bulk pull reads effective configuration and local refs in batches. Remotes
with automatic tag following retain the ordinary atomic pruning fetch, since
a new tag can be published without changing any branch tip. A second ref batch
compares branch and tag names/ids to decide whether indexing and family-state
recomputation are necessary. For an ordinary wildcard remote explicitly set to
`tagOpt=--no-tags`, one `ls-remote` can skip fetch when branch tips are equal.
Custom mappings and explicit tag-pruning configuration retain ordinary fetch.
An explicit bulk Fetch always fetches.

Current, ahead-only and untracked checkouts get one lightweight
`status --porcelain=v2 --branch --untracked-files=no` under their checkout lock.
This revalidates HEAD and its live upstream relationship after networking and
queue waits, and detects unmerged index entries even without operation markers.
Changed, pending, diverged or uncertain checkouts retain the full safety checks
and the second inspection immediately before mutation. Cleaning a blocked
checkout or resetting a local branch does not require another remote change.

Conditional includes and worktree configuration add an effective-configuration
probe for each candidate linked checkout. Identity-only differences still use
the shortcut; tracking differences retain the ordinary inspection path. Custom
fetch mappings retain the ordinary fetch path. Unchanged refs skip branch-index
and full worktree-state recomputation, including after a no-change fetch.
Changed refs (including newly followed tags), unavailable comparisons and
checkout updates retain the family refresh, since default-branch movement can
affect siblings' badges too. A current single-remote repository uses four Git
processes plus one lightweight status per checkout; the explicit no-tags route
uses three plus one per checkout. Published-tag checks retain their own hourly cadence and
setting. The process-count oracle is
`bulk-sync-preflight.property.test.ts`; actual energy savings still need a new
representative recording.

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

## Automatic CPU profiles

Settings → Troubleshooting → Hot CPU Profiling arms one recorder for the main
process and one for each profile window. The shared recorder follows PwrAgent's
hot-CPU capture behavior: sample process CPU every two seconds, evaluate the
selected trigger, and save recent history plus 15 seconds after the trigger.
Spike needs one sample at 50%, Sustained needs two, and Slow burn needs two at
15%. Percentages describe one CPU core, using cumulative CPU deltas when
Electron supplies them.

While armed, V8 sampling runs continuously. History stays in memory: a live
30-second window and the previous complete window, rotated after evaluating
the CPU sample. A burst spanning a rotation is retained. A triggered profile
can therefore include up to about 60 seconds of history before the 15-second
follow-up. Untriggered history is discarded, and each recorder saves at most
five profiles per session with a 60-second trigger cooldown. This is opt-in
instrumentation with sampling overhead, not a passive power meter.

Each recorder writes a `hot-cpu-*` directory beneath the diagnostics output
folder. `session.json` identifies `main` or `renderer`, the app/runtime versions,
and saved artifacts. `samples.ndjson` records CPU readings, and `events.ndjson`
records triggers, failures, pre-trigger duration, and shutdown. Open
`main-hot-*.cpuprofile` or `renderer-hot-*.cpuprofile` in Chrome DevTools to
inspect JavaScript stacks. Settings changes and app shutdown flush triggered
profiles; untriggered recordings do not produce a `.cpuprofile`.

**Chromium performance trace** adds a rolling 32 MiB browser trace to
renderer captures when enabled. The `.trace.json` beside the CPU profile
contains timing events for layout, paint and compositing. The export omits
event arguments and free-form labels, retaining timing fields and known
event and track names. Unfiltered data is staged in a private temporary
directory and removed after export. If Chromium tracing fails to start or
export, hot CPU profiling can still run and publish CPU profiles.

Completed captures produce a standing CPU notice using PwrAgnt's compact
header, copy/close icons, and arrow navigation. Copy includes the source host,
app identity, capture time and trigger, session/profile names and full paths,
and heap artifacts. Where supported, the clipboard also carries a formatted
code block. Notices remain until explicitly dismissed in that
window; they are not persisted across window closure or app restart. Previous
and Next arrows page through the captures, and Dismiss all clears
only that group. Later captures produce new notices. Renderer captures notify
their producing profile; main captures are app-wide. Saved profile files remain
available in the diagnostics folder after a notice is dismissed.

Main-process recording is shared across windows. Startup profiling owns the
main V8 profiler until it finishes; automatic recording waits for that owner
to release it. Heap monitoring or an attached debugger can prevent renderer
recording. Main-process hot-CPU recording continues with cheap heap counters
and never takes automatic blocking heap snapshots through this capture path.
The optional heap snapshots attached to hot profiles apply only to renderers.

These profiles do not sample spawned Git processes or explain GPU/native
stacks. Correlate them with the resource recorder's Git activity counters;
use an OS profiler when the expensive work is outside JavaScript. A recording
from the installed app reflects that build, even when a worktree contains newer
profiler code.
