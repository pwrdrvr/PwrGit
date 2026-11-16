# Renderer bytecode and owner-stack investigation — 2026-11-15

This investigation used the isolated `mwijl0p/PwrGit` checkout at
`e2948302` on **macOS 27.2 (26B123), arm64**. It found no renderer functions
above the 48 KiB budget. MaintenanceDialog nevertheless showed a repeatable
local Sparkplug cost, justifying a small render-frame extraction. These are
single-machine measurements, not a cross-platform performance claim.

## Toolchain and limits

| Runtime/tool | Installed version |
| --- | --- |
| Node | 24.22.1 |
| Node V8 | 13.6.233.17-node.58 |
| Electron | 44.9.3 |
| Electron embedded Node / Chrome | 24.22.0 / 152.0.7977.167 |
| Electron V8 | 15.2.124.43-electron.0 |
| React | 19.3.1 |
| Vitest / Vite | 4.1.12 / 7.3.7 |
| electron-vite / esbuild | 5.0.0 / 0.28.1 |
| pnpm | 12.13.0 |

Both installed runtimes' `--v8-options` reported Sparkplug enabled and
`--max-optimized-bytecode-size=61440`. The guard's 49,152-byte budget leaves
12,288 bytes below that TurboFan cutoff. It does not assert that a function
will be optimized or predict its execution time. Electron was queried and
audited using its exact checkout-local binary with `ELECTRON_RUN_AS_NODE=1`;
no Electron application or window was launched.

No prior bytecode/function-size work or owner was found among PwrGit's open
and recent PRs or a repository-wide issue/PR search. The reference guard's
head was verified: PwrAgent #3756 had merged at
`30e49f153a5016f253e27e99bca9af95010a2b95`.

## Repeated timing measurements

Representative file:
`apps/desktop/src/renderer/src/features/sidebar/MaintenanceDialog.test.tsx`.
Its original **60 cases** were selected before changing the component. Each
sample used a fresh plain Node process invoking the installed Vitest CLI,
one fork worker, normal process isolation, the existing runner/setup and
normal development transforms. Three paired samples were run before and
three paired samples after the extraction. No seed, timeout or retry was
changed. The new owner-stack regression case was excluded from after samples
so the measured workload remained the same 60 cases.

| Code | Node mode | Individual file test durations (ms) | Median (ms) |
| --- | --- | --- | --- |
| before | plain | 1,257.05 / 2,007.95 / 1,311.04 | 1,311.04 |
| before | no-sparkplug | 1,005.63 / 945.02 / 977.89 | 977.89 |
| after | plain | 1,016.24 / 1,056.42 / 1,025.12 | 1,025.12 |
| after | no-sparkplug | 989.45 / 1,049.52 / 935.94 | 989.45 |

The original flag gap is **25.4%**; after the extraction it is **3.5%**.
Ordinary Sparkplug-enabled median test time fell **21.8%**. There is a large
second-sample baseline outlier; medians and all samples are retained. The
[CSV](2026-11-15-renderer-owner-stacks-macos-arm64.csv) records every individual
case's duration for all twelve valid runs, plus the file's Vitest
`endTime - startTime`. These times include normal test hooks, not module
import/setup. End-to-end CLI breakdowns are:

- before plain: 2.18s (transform 308ms, setup 20ms, import 335ms, tests 1.26s, environment 442ms); 2.83s (transform 351ms, setup 20ms, import 383ms, tests 2.01s, environment 304ms); 2.08s (transform 313ms, setup 20ms, import 346ms, tests 1.31s, environment 293ms)
- before no-sparkplug: 1.81s (transform 308ms, setup 19ms, import 341ms, tests 1.01s, environment 315ms); 2.00s (transform 361ms, setup 46ms, import 360ms, tests 946ms, environment 481ms); 1.88s (transform 361ms, setup 25ms, import 398ms, tests 980ms, environment 340ms)
- after plain: 1.98s (transform 345ms, setup 24ms, import 378ms, tests 1.02s, environment 439ms); 1.84s (transform 311ms, setup 22ms, import 338ms, tests 1.06s, environment 312ms); 1.82s (transform 320ms, setup 19ms, import 361ms, tests 1.03s, environment 306ms)
- after no-sparkplug: 1.78s (transform 303ms, setup 21ms, import 331ms, tests 991ms, environment 314ms); 1.84s (transform 299ms, setup 19ms, import 331ms, tests 1.05s, environment 315ms); 1.73s (transform 305ms, setup 19ms, import 335ms, tests 937ms, environment 319ms)

The repository config, resource launcher and CI contain no Sparkplug override.
An exploratory invocation revealed that **Vitest 4 filters parent V8 flags**;
a plain `node --no-sparkplug vitest.mjs` alone does not change its forks. Those
unforwarded pilot invocations are excluded from the comparison. The temporary
measurement config imported the normal config and added:

```ts
server: { hmr: false },
test: {
  ...config.test,
  execArgv: process.execArgv.filter(arg => arg === '--no-sparkplug'),
  setupFiles: [...config.test.setupFiles, '.local/bytecode-runtime.mjs']
}
```

The extra setup printed Node/V8 versions, `process.execArgv`, and `NODE_OPTIONS`
from each worker. All valid flag samples included `--no-sparkplug` in the
worker; ordinary samples did not. `NODE_OPTIONS` was empty. Vitest also added
its normal import-meta-resolve/suppress-warnings arguments and
`--conditions node --conditions development` to both groups.

The command shape was:

```sh
node scripts/resource-run.mjs node [--no-sparkplug] node_modules/vitest/vitest.mjs \
  run apps/desktop/src/renderer/src/features/sidebar/MaintenanceDialog.test.tsx \
  --config .local/bytecode-timing.config.mts --maxWorkers=1 --no-fileParallelism \
  --reporter=verbose --reporter=json --outputFile.json=<sample.json>
```

After samples also passed `-t '^(?!.*constructs owner stacks)'`. The twelve
bounded raw verbose logs (145,516 bytes total), JSON reports, temporary config,
worker flags, V8-option output and complete bytecode records remain under
`.local/bytecode-evidence/` in this checkout. Full disassembly was streamed
and discarded. The CSV preserves all valid case/file timings in the PR.

## Bytecode audit

Automatic discovery covered **324 renderer modules**, including hooks,
utilities, workers, nested and anonymous functions. Three source variants
(Vitest SSR, Vitest client/jsdom, electron-vite development) plus five actual
production JavaScript chunks/worker assets yielded **977 module/variants**.
The valid before audit had 28,789 function records in each runtime; after had
28,797. All were within budget on both installed V8 versions.

The largest original source functions, using actual Node Vitest SSR output
(client/jsdom lengths matched in this checkout), were:

| Module | Function | Bytes |
| --- | --- | ---: |
| MaintenanceDialog.tsx | MaintenanceDialog | 30,437 |
| CloneRepoDialog.tsx | CloneRepoDialog | 25,328 |
| ContributionScreen.tsx | ContributionScreen | 22,735 |
| ForkRepoDialog.tsx | ForkRepoDialog | 20,773 |
| App.tsx | App | 18,906 |
| RepoRefsModal.tsx | RepoRefsModal | 16,841 |
| PruneWorktreesPanel.tsx | PruneWorktreesPanel | 15,097 |
| Sidebar.tsx | Sidebar | 14,452 |
| ResetToRemoteDialog.tsx | ResetToRemoteDialog | 13,539 |
| RepoRow.tsx | RepoRow | 13,371 |
| LineageGraph.tsx | LineageGraph | 12,517 |
| WorktreeHeader.tsx | WorktreeHeader | 12,473 |

| Runtime / variant | Original controller | New controller | Render callback | Stable child |
| --- | ---: | ---: | ---: | ---: |
| Node, Vitest SSR and jsdom | 30,437 | 10,378 | 19,192 | 9 |
| Node, development | 28,231 | 9,963 | 18,033 | 9 |
| Electron, Vitest SSR and jsdom | 29,937 | 10,353 | 18,690 | 9 |
| Electron, development | 27,727 | 9,934 | 17,547 | 9 |

| Runtime | Original production maximum | New production maximum | New source maximum (Vitest) |
| --- | ---: | ---: | ---: |
| Node | 27,584 | 25,971 | 25,328 (CloneRepoDialog) |
| Electron | 27,080 | 25,919 | 25,193 (CloneRepoDialog) |

Production lengths come from the **actual minified production renderer build**,
including dependencies and workers, rather than a stand-in compressor. The
maximum after the split is a module initializer. Production function names are
mangled; these are whole-output maxima, not inferred mappings to source names.
Even that largest Node function has 23,181 bytes of room below the guard.
Other components were left alone because no timing experiment justified
changing them. See [coverage and platform boundaries](../renderer-bytecode.md).

## Deterministic verification

The owner-stack oracle intercepts only the React development JSX Error during
a StrictMode update. On pre-fix code it failed: **102** captures included the
MaintenanceDialog controller frame instead of the allowed two small child
allocations. With the extraction, it passes with exactly two and verifies that
the existing dialog DOM node is retained. It uses no elapsed-time assertion.
Hooks and effects remain in the controller; the module-scope child invokes its
render callback after the controller has returned. The callback changes as
state changes; the component type, keys, refs and mounted subtree stay stable.
There is no intended visible UI change.

The broad guard oracle passed four tests. It discovers new modules without an
export-name list and compiles valid/oversized nested fixtures through all four
variants. The oversized fixture yields eight failures (named and anonymous
functions in each variant); the valid fixture passes. Neither the application
module nor its sentinel import executes. Inclusive budget boundaries and
malformed bytecode records are also checked.

Validation: **104 tests in seven affected suites passed**, including the full
MaintenanceDialog suite, Clones/Prune behavior and maintenance-attach model
properties. `pnpm lint` passed syntax, forge/color policy, dependency maturity,
licenses, boundaries, workspace typecheck and the new guard. `pnpm build`
passed. No visible Electron E2E was needed for this controller-frame change;
no UI appearance or host DOM structure changed. No global Sparkplug flag,
retry or timeout override was added.

[Follow-up #603](https://github.com/pwrdrvr/PwrGit/issues/603) tracks Linux and
Windows comparisons before any broader timing-driven splits, following
CONTRIBUTING.md's GitHub Issues process.
