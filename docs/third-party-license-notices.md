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
