# scripts/

Repo-wide policy, license, and release checks. Most are wired into `pnpm lint`
through the root `package.json`; add new repo-wide checks to that chain rather
than as another CI step.

Every script here is both an importable module (its checks are unit tested) and
a CLI, so each guards `runCli()` with `isCliEntrypoint(import.meta.url)` from
[lib/cli-entrypoint.mjs](lib/cli-entrypoint.mjs). Use it rather than
open-coding the `process.argv[1]` comparison a fourth time.

## The dependency cooldown

`check-dependency-maturity.mjs` (`pnpm deps:maturity`) re-applies
`minimumReleaseAge` from `pnpm-workspace.yaml` — seven days — to every version
pinned in `pnpm-lock.yaml`.

pnpm enforces that setting **only while it resolves**, and this repo almost
never resolves. `pnpm install --frozen-lockfile` prints "resolution step is
skipped", so install, typecheck, test, build and E2E all pass over a
day-old dependency without a word. The one command that resolves from scratch
is the release's `pnpm deploy --legacy`, which re-applies the gate to the
lockfile's pinned versions. That is a policy enforced at exactly the last step
that can act on it: zod 4.5.1 merged clean via Dependabot and then blocked
v0.11.0 at packaging, with nothing to do but wait out the window.

Three things close that gap, and they only work together:

| Where | What it does |
|---|---|
| `cooldown` in `.github/dependabot.yml` | No PR is opened for a release younger than the window, so the state normally never arises. |
| `minimumReleaseAge` in `pnpm-workspace.yaml` | The window is the repo's, identical on every machine and in CI. It previously lived only in individual developers' pnpm config — enforced for one person, absent from CI, and the reason the failure looked machine-specific. |
| `pnpm deps:maturity` in the `pnpm lint` chain | Fails the PR that lands a too-young version, not the release that ships it. Also runs first in `release.mjs`, so a release fails in seconds instead of after a full build. |

Publish times come from the registry, so the check needs network for releases
it has not seen; they are immutable, so
`node_modules/.cache/pwrgit/dependency-publish-times.json` keeps the ones the
current lockfile needs and only new pins cost a request.

**Adding a `minimumReleaseAgeExclude` entry is a supply-chain decision.** The
window exists so a compromised publish has a week to be caught. Prefer waiting
it out. When a release genuinely has to be taken early, pin the exact version
(`zod@4.5.1`, never a bare `zod`) and say why in a comment — a bare name
exempts every future version of that package, which is what the standing
`@pwrdrvr/*` entries deliberately do and what a one-off waiver must not. The
check reports a pin as prunable once its version has matured or left the
lockfile; it never fails over that.

Semver ranges (`zod@^4.5.0`) are rejected even though pnpm accepts them. An
allowlist entry covering more releases than its author intended is the failure
mode worth designing against.

## The three license scripts

`pnpm licenses:check` runs them in this order, and they do different jobs:

| Script | Checks |
|---|---|
| `check-package-license-policy.mjs` | OUR five workspace `package.json` files declare MIT, plus `LICENSE` and the electron-builder attribution. **Never looks at a dependency.** |
| `check-third-party-license-allowlist.mjs` | Every license the notice discloses is on an explicit allowlist. This is the gate. |
| `generate-third-party-licenses.mjs` | Transcribes the tree into `THIRD_PARTY_LICENSES`. **Judges nothing.** |

That last row is why the gate exists. The generator groups records by whatever
license string pnpm hands it, so before the gate a dependency flipping
MIT → GPL-3.0 wrote a new `GPL-3.0` section into the notice and
`licenses:generate --check` then PASSED — committed file matches generated
file, green CI, copyleft shipped, nobody told. The only safety was that a human
might spot a new heading in the diff, which is worth nothing once regeneration
is automated on a Dependabot branch.

## Always-allowed licenses

`ALLOWED_LICENSE_IDS`: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
Unlicense, CC0-1.0, MPL-2.0, BlueOak-1.0.0, OFL-1.1, Python-2.0. Anything else
in a **shipped** dependency: pause and confirm with the user before adding the
dep. Dev-only tooling is out of scope (the tree already carries WTFPL and
CC-BY-4.0 there, harmlessly).

The list was seeded from what the tree actually declares, reconciled against
the permissive set the Pwr family treats as always-allowed. PwrGit documented
no allowlist at all before the gate, so BlueOak-1.0.0, OFL-1.1 and Python-2.0
had arrived without anyone deciding. That is the drift an unenforced policy
accumulates; the reconciled list is recorded above and in the script.

Adding an id is a legal decision. Make it in a commit that says why — **never
to make CI green.**

## The GPL-2.0 carve-out for embedded Git

PwrGit ships a strong-copyleft binary on purpose: Dugite downloads Git, and
`EMBEDDED_GIT_NOTICE_SOURCES` discloses it as GPL-2.0-only. A permissive-only
allowlist would be wrong here, so `ALLOWED_EMBEDDED_COPYLEFT_IDS` permits that
one id for the embedded-runtime surface **only**, and only for an entry
carrying a `copyleft` descriptor naming its corresponding source. The same
string on an ordinary npm dependency fails — a dependency is linked into the
app, and nothing would put its source pointer in the notice.

Both sides enforce it: the gate refuses a copyleft runtime with no descriptor,
and `validateEmbeddedNoticeSource` refuses to generate a notice for one. Keep
them in step.

**Open legal question, not closed by this gate.** Git is invoked as a separate
executable over a process boundary, so PwrGit is not a derivative work of it —
but PwrGit does redistribute the binary, which carries GPL-2.0 section 3. The
notice now reproduces the GPL text and points at the exact corresponding
source, which reads on 3(a); it carries **no** written offer under 3(b). If
counsel wants the 3(b) offer, it belongs in the `copyleft` descriptor so the
generator emits it. Do not treat the carve-out as a ruling that the disclosure
is complete.

## What the gate covers, exactly

Its input set is the notice's contents — three surfaces, all read:

1. The npm production tree (`NOTICE_PNPM_ARGS.production`).
2. `NOTICE_DEV_DEPENDENCIES` out of the `all` report. Electron is a
   devDependency that ships, so `--prod` never reports it; the generator merges
   it in and the gate follows. **Keep the two in step** — a name the generator
   discloses but the set omits is the largest shipped component with an ungated
   license.
3. `EMBEDDED_GIT_NOTICE_SOURCES`, the Dugite runtimes.

**Not** covered: optional dependencies (`--no-optional` is what makes the notice
platform-identical, so neither report enumerates them — an optional dependency
that ships is disclosed by neither the notice nor the gate until someone adds
it deliberately); devDependencies outside `NOTICE_DEV_DEPENDENCIES`; and
Chromium's own credits inside Electron, which the notice points at upstream.
