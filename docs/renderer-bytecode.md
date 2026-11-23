# Renderer bytecode headroom

Run `pnpm check:renderer-bytecode` locally. It also runs at the end of
`pnpm lint`, so the existing CI Typecheck job enforces it. Use the `.nvmrc`
Node and install this checkout's dependencies first.

Every compiled function must use at most **28,672 bytes (28 KiB)**. The gate
is set near the current maximum of 25,971 bytes, leaving 2,701 bytes (10.4%)
for growth. It rejects the original 30,437-byte MaintenanceDialog controller,
whose development owner-stack cost reproduced below V8's optimization cutoff.
The initial 48 KiB ceiling left too much room for that regression.

Both installed Node and Electron V8 defaults for
`--max-optimized-bytecode-size` are 61,440 bytes. That cutoff is an eligibility
limit, not a performance target or a promise that V8 will optimize a function.
Source lines and source-file size are not substitutes for this measurement.

## Coverage and implementation

The guard adapts [PwrAgent PR #3756](https://github.com/pwrdrvr/PwrAgent/pull/3756)
at `30e49f153a5016f253e27e99bca9af95010a2b95` to PwrGit's toolchain.

- Recursively discover every `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`,
  `.mjs` and `.cjs` file under `apps/desktop/src/renderer/src`, including
  hooks, utilities, workers and modules not currently imported by an entry.
  Exclude declarations, `.test`/`.spec` files, `test-support`, `__tests__`,
  dependency directories and symlinks.
- Ask the installed Vitest/Vite pipeline for **both SSR and client/jsdom**
  module-runner output. Match Vitest 4's strict async wrapper, including its
  CJS globals; the wrapper's context layout affects function bytecode.
- Check the actual electron-vite development transform, including React's
  development JSX and Fast Refresh hook instrumentation. Keep HMR enabled in
  the transform configuration with its WebSocket transport disabled. Skip
  startup dependency discovery on this compile-only server so shutdown has no
  dependency scan to cancel. Use a dedicated Vite cache for the oracle so
  plugin-provided prebundles cannot replace the desktop dev server's bundles.
- Build the actual production renderer configuration in production mode,
  with its esbuild minifier, into memory. Check all emitted JavaScript
  chunks and worker assets, including bundled dependencies. Production
  names are mangled, so diagnostics identify the emitted chunk and V8 name.
  Tree-shaken functions are covered in source variants, not in production.
- Compile in a disposable `--no-lazy --experimental-vm-modules` Node child.
  `vm.Script` and `vm.SourceTextModule` compile without linking/evaluating
  application modules or executing imports. Eager compilation finds nested,
  anonymous, arrow and method functions without a component-name allowlist.
  A unique trailing comment prevents V8's compilation cache from hiding
  identical client/SSR variants. Forward inherited heap-limit settings from
  `NODE_OPTIONS` and parent Node arguments to the compiler's arguments, with
  command-line precedence preserved. Clear other inherited Node options so
  tier flags and preloads cannot alter the oracle; the resource launcher's
  2,048 MiB old-space cap remains in force on constrained machines.
- Stream and reduce bytecode disassembly into function lengths. Keep only
  records, bounded compiler stderr and the largest twelve diagnostics; never
  buffer the disassembly. Missing bytecode or transforms fail closed.
  `--json output.json` optionally retains every function record for audits.

The guard covers renderer code, not main/preload code, externalized dev/test
dependencies, HTML inline scripts or runtime-generated JavaScript. Node is
the portable CI oracle; Electron V8 and other architectures can emit different
lengths. Re-audit the installed Electron runtime on upgrades, and verify its
cutoff rather than assuming the default stays fixed.

The script's oracle tests compile valid and deliberately oversized fixtures
through every pipeline. Each fixture contains unexported named and anonymous
nested functions. The oversized fixture must produce two budget failures in
each variant, with module/function/size/limit diagnostics; the valid fixture
must pass. Oversized fixture functions must stay within 4 KiB above the
budget, so unnecessary disassembly does not compete with the full CI suite.
This work bound uses bytecode lengths, not elapsed time. Sentinel imports
and top-level throws prove compilation never executes the fixture or its
imports.

## React development owner stacks

React 19 development JSX captures `Error("react-stack-top-frame")` owner
stacks. Sparkplug stack capture can make late JSX calls in a large active
function expensive, even below the optimization cutoff. The bytecode guard
provides headroom; it does not assert a wall-clock performance guarantee.

Before splitting for performance, measure the same representative test file
three times with plain `node` invoking Vitest and three times with
`node --no-sparkplug`. Inspect worker flags: Vitest 4 filters the parent's
V8 arguments. Use a temporary config to forward only the experimental flag
to test workers, retaining the normal transforms, isolation and setup. Never
commit the override, timing thresholds, retries or inflated timeouts.

If a controller remains expensive on the active stack, return a stable child
that invokes a render callback after the controller returns. Keep the child
at module scope; defining a new component type during each render remounts
its tree. Preserve hooks, keys, refs and effect lifecycles. Recheck all
variants and behavior after the change.

The [macOS arm64 investigation](benchmarks/2026-11-15-renderer-owner-stacks.md)
records the measurements behind MaintenanceDialog's render-frame extraction.
