# scripts/

Repo-wide policy, license and release checks.

- Most run in `pnpm lint` via the root `package.json`. Add a new repo-wide
  check to that chain, not as another CI step.
- Each script is an importable, unit-tested module and a CLI. Guard `runCli()`
  with `isCliEntrypoint(import.meta.url)` from
  [lib/cli-entrypoint.mjs](lib/cli-entrypoint.mjs). Do not open-code the
  `process.argv[1]` comparison.

## Machine resource policy

`resource-run.mjs` wraps repository checks, builds, dev/watch commands and
package tools. The policy is for developer machines that run several builds
at once.

- Capacity is the lowest of host total, OS limit and every visible cgroup
  ancestor.
- Below 16 GiB: 2048 MiB Node old space and one workspace or test worker.
- At 16 GiB or above: argv and environment pass through unchanged.
- CI (nonempty `CI` except `false`/`0`, or `GITHUB_ACTIONS=true`) bypasses the
  cap, shared lane and worker limits. It keeps the job's environment, argv and
  parallelism.
- Keep Vitest's default process isolation. SQLite staging supports native
  test workers separately from Electron.

### The shared lock contract

PwrGit and PwrAgent share this lock. Change the contract only in both
projects together.

- Lock: `~/.cache/pwragent-tools-<sha256(home)[0:16]>/heavy-tool`, via
  proper-lockfile (30 s stale, 5 s heartbeat).
- The sibling `heavy-tool.owner.json` and `PWRAGENT_TOOL_RESOURCE_OWNER` carry
  matching `{pid,path,token}`. The sidecar also records `ownerStartedAt`.
- On POSIX the sidecar also records `groupPid`, `groupStartedAt`, a separate
  fresh `descendantToken`, and observed `descendantGroups: [{pid,startedAt}]`.
- Publish the identities and the private capability before starting tools.
- The internal `PWRAGENT_TOOL_DESCENDANT_TOKEN` marks only constrained POSIX
  bridge/tool descendants, so fast-exiting launchers can be recovered after
  reparenting. Copied owner JSON alone grants no cleanup.
- Keep the inherited owner environment at exactly three fields.
- Validate start identities before stale recovery or signalling. Legacy live
  owners with unreadable or missing identities fail closed; keep that.
- Only verified descendants inherit a lease. Keep fixture lanes separate from
  the outer test runner's lease.

### Running heavy tools

- Run ad hoc heavy probes with `node scripts/resource-run.mjs <tool> ...`.
  Direct `pnpm exec` or `node` calls bypass the launcher.
- Long-running dev and watch commands hold the lane until they exit.
- Cancellation drains the primary and detached POSIX tool groups, or the
  Windows native Job, before it releases the lease. Do not replace Windows Job
  ownership with a `taskkill /T` fallback.

## Syntax correctness lint

`lint:syntax` runs exact-pinned Oxlint with `.oxlintrc.json` from the repo
root.

- Rules are explicit, so a new plugin cannot silently enable rule categories.
- Classic Rules of Hooks apply only to renderer sources. React Compiler
  migration rules are out of scope.
- `tsconfig.base.json` owns TS unused bindings, including strict `_` locals.
  JS files use Oxlint's unused-binding check.
- Excluded: generated output, dependency trees, standalone design prototypes.
- The `no-empty-pattern` exceptions cover Playwright's destructured fixture
  parameters and the renderer's `act` fixture. Keep them narrow.
- `oxlint-config.test.mjs` injects unsafe-access and conditional-Hooks defects
  to verify scope and rejection. Keep test-shaped probes outside Vitest's
  discovered patterns, so watch mode does not run them as suites.
- Syntax lint adds coverage; PwrGit had no ESLint baseline.
- Oxfmt or other auto-formatting needs its own scoped change. Do not bulk
  format with correctness checks.

## Typecheck: which compiler, and what it gates

- `pnpm typecheck` runs the exact-pinned TypeScript 7 native compiler
  (`typescript-native` alias) through `typecheck.mjs`.
- TypeScript 6 (`typescript`) stays for dependency-cruiser's JavaScript API
  and the MCP server's declaration/JS emit.
- Both publish `tsc`. Never rely on whichever wins `node_modules/.bin/tsc`.
- `PWRGIT_TYPECHECK_COMPILER=typescript pnpm typecheck` runs TS6, for
  comparison or fallback. Editor/LSP compiler selection is independent.

`tsconfig.base.json` sets `noUnusedLocals` and `noUnusedParameters`.
`apps/desktop`, `packages/mcp-server` and `packages/shared` extend it.

- An unused import or local, or the dead value half of
  `import { x, type X }`, fails `pnpm typecheck` and `pnpm lint`. It also
  fails `pnpm build` for `packages/mcp-server` (its build is `tsc`).
- The desktop build (electron-vite) type-checks nothing. Trust
  `pnpm typecheck`.

Blind spots, verified by probe:

- **A leading `_` exempts parameters and imports, but not locals.**
  `function f(_x: string) {}` and `import { y as _y } from "./m"` are silent;
  `const _z = 1` is still TS6133. Use the prefix for a parameter that
  documents a signature (a test double's ignored argument, a `describe.each`
  title slot). Never use it to hide a dead import.
- **An export nobody imports is invisible.** After you delete an import, grep
  for the symbol.

"The compiler says unused" is not "dead code". In a test, an unused binding is
often a missing assertion. Find its purpose before you delete it.

## Compiler measurements

`benchmark-checks.mjs OUTPUT` compares TS7 and TS6 on macOS through
`resource-run.mjs`.

- Conditions: identical sources, configs and dependencies; three paired
  workspace typecheck/full-lint samples; warm caches; CI mode; 6 GiB Node old
  space.
- Before timing, it verifies repository file inventories and that injected
  type and unused-binding defects are rejected.
- Inventory paths and compiler `PWD` use the physical checkout path.
- Timed commands use an IPC gate and the POSIX descendant tracker. On timeout,
  cleanup drains the full command tree before returning, and sampling stops.
- Run on the managed E2E guest or the opt-in CI workflow. Do not compare
  hardware or infer editor/session memory from process RSS.
- Keep raw artifacts outside Git.

## The dependency cooldown

`check-dependency-maturity.mjs` (`pnpm deps:maturity`) applies
`minimumReleaseAge` from `pnpm-workspace.yaml` (seven days) to every version
pinned in `pnpm-lock.yaml`.

Why: pnpm enforces `minimumReleaseAge` **only while it resolves**, and this
repo almost never resolves. `pnpm install --frozen-lockfile` prints
"resolution step is skipped". Install, typecheck, test, build and E2E all pass
a one-day-old dependency silently. Only the release's `pnpm deploy --legacy`
resolves from scratch and applies the gate. Example: zod 4.5.1 merged through
Dependabot, then blocked v0.11.0 at packaging until the window ended.

Three controls close that gap. They work only together:

| Where | What it does |
|---|---|
| `cooldown` in `.github/dependabot.yml` | No PR opens for a release younger than the window. |
| `minimumReleaseAge` in `pnpm-workspace.yaml` | The window is the repo's, identical on every machine and in CI. In personal pnpm config it was absent from CI, so failures looked machine-specific. |
| `pnpm deps:maturity` in the `pnpm lint` chain | Fails the PR that adds a too-young version, not the release. It also runs first in `release.mjs`, so a release fails in seconds, not after a full build. |

Publish times come from the registry, so new pins need network. They are
immutable: `node_modules/.cache/pwrgit/dependency-publish-times.json` keeps the
ones the current lockfile needs.

### Exclusions

**Adding a `minimumReleaseAgeExclude` entry is a supply-chain decision.**

- The window gives a compromised publish one week to be found. Prefer to wait.
- To take a release early, pin the exact version (`zod@4.5.1`, never bare
  `zod`) and add a comment that says why.
- A bare name exempts every future version. The standing `@pwrdrvr/*` entries
  do this intentionally; a one-off waiver must not.
- The check reports a pin as prunable when its version has matured or left
  the lockfile. It never fails for that.
- Semver ranges (`zod@^4.5.0`) are rejected, although pnpm accepts them. An
  entry that covers more releases than its author intended is the failure
  this design prevents.

## The three license scripts

`pnpm licenses:check` runs them in this order:

| Script | Checks |
|---|---|
| `check-package-license-policy.mjs` | OUR five workspace `package.json` files declare MIT; also `LICENSE` and the electron-builder attribution. **Never looks at a dependency.** It also keeps former-employer names out of tracked files (a name failure is not a license failure). A public npm name (`@scope/pkg`) may appear anywhere; only the bare vendor name is flagged. |
| `check-third-party-license-allowlist.mjs` | Every license the notice discloses is on an explicit allowlist. This is the gate. |
| `generate-third-party-licenses.mjs` | Writes the tree into `THIRD_PARTY_LICENSES`. **Judges nothing.** |

Why the gate exists: the generator groups records by pnpm's license string.
Before the gate, a dependency that changed MIT → GPL-3.0 added a `GPL-3.0`
section, and `licenses:generate --check` PASSED: CI was green and copyleft
shipped silently. Only a human reading the diff could catch it, and Dependabot
branches regenerate automatically.

## Always-allowed licenses

`ALLOWED_LICENSE_IDS`: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
Unlicense, CC0-1.0, MPL-2.0, BlueOak-1.0.0, OFL-1.1, Python-2.0.

- A **shipped** dependency under any other license: stop and confirm with the
  user before you add it.
- Dev-only tooling is out of scope (the tree has WTFPL and CC-BY-4.0 there,
  harmlessly).
- The list is the tree's declared licenses reconciled with the Pwr family's
  always-allowed permissive set. BlueOak-1.0.0, OFL-1.1 and Python-2.0 had
  arrived with no decision, because no allowlist was enforced.

**Adding an id is a legal decision.** Make it in a commit that says why.
**Never add an id to make CI green.**

## The GPL-2.0 carve-out for embedded Git

PwrGit ships a strong-copyleft binary intentionally: Dugite downloads Git, and
`EMBEDDED_GIT_NOTICE_SOURCES` discloses it as GPL-2.0-only.

- `ALLOWED_EMBEDDED_COPYLEFT_IDS` permits that one id for the
  embedded-runtime surface **only**, and only for an entry with a `copyleft`
  descriptor that names its corresponding source.
- The same id on an npm dependency fails. A dependency is linked into the
  app, and nothing would put its source pointer in the notice.
- Both sides enforce it: the gate refuses a copyleft runtime with no
  descriptor, and `validateEmbeddedNoticeSource` refuses to generate a notice
  for one. Keep them in step.

**Open legal question, not closed by this gate.**

- Git runs as a separate executable across a process boundary, so PwrGit is
  not a derivative work. But PwrGit redistributes the binary, which carries
  GPL-2.0 section 3.
- The notice reproduces the GPL text and points at the exact corresponding
  source (3(a)). It has **no** written offer under 3(b).
- If counsel wants the 3(b) offer, put it in the `copyleft` descriptor so the
  generator emits it.
- Do not treat the carve-out as a ruling that the disclosure is complete.

## What the gate covers, exactly

The gate reads all three surfaces of the notice:

1. The npm production tree (`NOTICE_PNPM_ARGS.production`).
2. `NOTICE_DEV_DEPENDENCIES` from the `all` report. Electron is a shipped
   devDependency that `--prod` never reports; the generator merges it in and
   the gate follows. **Keep the two in step**, or the largest shipped
   component has an ungated license.
3. `EMBEDDED_GIT_NOTICE_SOURCES`, the Dugite runtimes.

**Not** covered:

- Optional dependencies. `--no-optional` keeps the notice identical across
  platforms, so neither report lists them. A shipped optional dependency is
  undisclosed and ungated until someone adds it deliberately.
- devDependencies outside `NOTICE_DEV_DEPENDENCIES`.
- Chromium's credits inside Electron. The notice points to them upstream.
