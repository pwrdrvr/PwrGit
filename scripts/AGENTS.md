# scripts/

Repo-wide policy, license, and release checks. Most are wired into `pnpm lint`
through the root `package.json`; add new repo-wide checks to that chain rather
than as another CI step.

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
