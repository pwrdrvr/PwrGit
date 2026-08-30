# Third-Party License Notices

PwrGit is MIT-licensed. The committed
[`THIRD_PARTY_LICENSES`](../THIRD_PARTY_LICENSES) file records the third-party
software shipped by the desktop app.

## Notice scope

The generator includes:

- npm production dependencies for `@pwrgit/desktop`;
- the Electron runtime and its MIT license;
- Geist Sans and Geist Mono font assets emitted by the renderer; and
- the Git, Git LFS, and Git Credential Manager runtimes bundled through
  Dugite outside npm's dependency inventory.

Electron's large generated `LICENSES.chromium.html` is not appended to the
plain-text notice. The notice points to Chromium's source credits and the
corresponding Electron runtime distribution instead.

The embedded Git notice sources live in
`apps/desktop/resources/embedded-git/`: `COPYING`, `LICENSE.git-lfs`,
`LICENSE.git-credential-manager`, and `NOTICE`. Packaging copies those files
beside the embedded runtime under `Resources/git` on macOS and `resources/git`
on Windows.

## License allowlist

`scripts/check-third-party-license-allowlist.mjs` gates the licenses the notice
discloses against an explicit allowlist. The generator itself only transcribes
what the tree declares, so without this gate a dependency that changed to a
copyleft license would have been written into the notice and passed the
committed-vs-generated check.

Allowed for any shipped dependency: MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, 0BSD, Unlicense, CC0-1.0, MPL-2.0, BlueOak-1.0.0, OFL-1.1,
Python-2.0. Each declared license is evaluated as an SPDX expression, so
`(WTFPL OR MIT)` passes on its MIT half while `Apache-2.0 AND GPL-3.0` fails.
A license string that cannot be parsed fails rather than being guessed at.

The one exception is the embedded Git runtime: GPL-2.0-only is permitted for an
`EMBEDDED_GIT_NOTICE_SOURCES` entry that carries a `copyleft` descriptor naming
its corresponding source, and nowhere else. Git is a separate executable
invoked over a process boundary, not code linked into PwrGit. The generated
notice's **Source Availability** section records where the source for each such
binary is published. Adding a license to either list is a licensing decision;
see [scripts/AGENTS.md](../scripts/AGENTS.md).

The gate covers npm production dependencies, the Electron runtime, and the
embedded Git runtimes. It does not cover optional dependencies (excluded from
the notice so it stays platform-identical), devDependencies that do not ship,
or Chromium's own credits inside Electron.

## Commands

After changing a production dependency, Electron, Dugite, a bundled font, or
an embedded runtime notice, regenerate and review:

```bash
pnpm licenses:generate
pnpm licenses:check
```

`pnpm lint` includes `licenses:check`, and the release orchestrator runs the
same check before building a deploy stage. If generation reports an incomplete
install, run `pnpm install` under the Node version from `.nvmrc` before trusting
the result.

Do not edit `THIRD_PARTY_LICENSES` by hand. The generator derives installed npm
versions and license texts, while its `EMBEDDED_GIT_NOTICE_SOURCES` inventory
owns the version and source metadata for bundled Git components. A Dugite
runtime update must update that inventory and the committed embedded notice
files together.

## Packaging checks

Release staging copies `LICENSE`, `THIRD_PARTY_LICENSES`, and `CHANGELOG.md` as
resources outside `app.asar`. The post-package checks verify the ASAR contents,
the universal macOS slices, and byte-for-byte equality of each embedded Git
notice beside the packaged runtime.

Linux currently participates only as a source build gate. No Linux package is
published, so the release notice policy covers the macOS and Windows artifacts
that are actually distributed. Revisit the generated inventory and packaged
notice verification before enabling Linux publication.
