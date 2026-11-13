# Shared Electron runtime extraction cache

PwrGit's `install:electron-binary` command delegates to
`ensure-electron-runtime.mjs`. Desktop `postinstall` runs it before SQLite
staging and the Linux sandbox check. Both Codex setup paths run ordinary
`pnpm install`; Windows bootstraps the exact `.nvmrc` Node and `packageManager`
pnpm with `scripts/windows-environment.ps1`. `ignoreScripts: false` explicitly
keeps workspace lifecycle hooks enabled. CI completed-tree cache keys include
the wrapper, adapter and runtime cache module; the import-closure guard follows
side-effect imports as well as `from` imports. Electron remains a devDependency;
production-only deployments and `ELECTRON_SKIP_BINARY_DOWNLOAD` still skip it.

## Upstream validation completed

On 2026-11-10, after the upstream CI prerequisite fired, I re-read both PR heads
through `gh`. PwrAgent #3580 remained at
`e64619ca8747e5c0c628ce6c6a87c07ed106f9eb` with passing CI (and had merged).
PwrGit #584's implementation head
`64423f72aa614e61212d173a2e6af7bb1962ff0d` also had passing CI. I fetched the
upstream cache module at that exact ref and confirmed it is byte-for-byte
identical to PwrGit's, with SHA-256
`8ee380445b204d1599ba757202e1849b68a749a5ab3ce2a650b68af49616fba6`.
No additional upstream code changes are required. The implementation is ready
for review; PR #584 remains a draft and is not automatically merged.

The allocation evidence below remains applicable: both disposable product
installs shared one verified runtime with zero private bytes across 260 regular
files. Independent extractions used 323,215,360 and 323,059,712 private bytes.
The report also confirms matching clone IDs/hashes, distinct inodes and private
write isolation. Worktree-only permission fallback is verified separately;
when shared storage cannot be used, a local runtime may allocate private data.

## Shared protocol

The cache is **the same cache as PwrAgent and PwrSnap**, at
`~/.pwragent/cache/electron-runtime/v1`. `PWRAGENT_HOME` overrides the home
containing `cache/electron-runtime/v1` in all three products, including tests.
No PwrGit-specific cache variable or product dimension is added. This affects
only install-time runtime caching; PwrGit's application state locations do not
change. Dependency trees remain independent in every checkout.

`electron-runtime-cache.mjs` derives from PwrAgent PR
[pwrdrvr/PwrAgent#3580](https://github.com/pwrdrvr/PwrAgent/pull/3580), head
`e64619ca8747e5c0c628ce6c6a87c07ed106f9eb`, with the bundled-extraction
compatibility fallback described below. The shared protocol is unchanged.
The adapter resolves Electron relative to this desktop layout and preserves
PwrGit's skip behavior.

The identity is constructed in this exact order:

```js
{ format: 1, version, platform, arch, checksum }
```

`checksum` is the verified ZIP's SHA-256; the key is
`SHA256(JSON.stringify(identity))`. Each entry contains `runtime.json` with
`identity` and the complete `files` inventory, plus `dist/`. The inventory
covers every directory, file hash, permission mode and relative symlink target.
Links that escape the runtime are rejected. Version, platform, architecture
and different archive bytes remain separate entries.

The adapter uses Electron's `@electron/get` and package checksums, honoring
`ELECTRON_INSTALL_PLATFORM` and `ELECTRON_INSTALL_ARCH` first, then
`npm_config_platform` and `npm_config_arch`, then the host target. It also honors
`force_no_cache`,
`electron_config_cache` and Electron's remote-checksum switches. It hashes the
returned ZIP again and compares the embedded release checksum when available.
Fresh installs need a verified ZIP from the download cache or network; the
extraction cache alone does not replace ZIP verification. A completed verified
install needs neither the cache nor network. A cached ZIP permits offline
installation into another disposable package.

## Publication and isolation

Extraction happens in a fresh stage and is validated before publication.
Concurrent publishers converge on a fully verified winning entry. Corrupt
entries are preserved for diagnosis and bypassed; unavailable caches cause
local extraction. Cache failure never makes installation depend on cache
availability. Installs are serialized per Electron package using a lock with
OS-confirmed dead-owner recovery. An empty lock directory is free: Windows
refuses `rmdir` while a waiter's `readdir` holds it open, so `EPERM`, `EACCES`
and `EBUSY` from that `rmdir` mean "busy", and a waiter reclaims the leftover
directory. `path.txt` and the installation manifest are
published only after verifying the staged runtime. Legacy or damaged installs
are replaced from a verified source.

macOS uses native `/bin/cp -cRpP` to create independent APFS clone files.
Elsewhere, or when native cloning fails, Node copies with
`COPYFILE_FICLONE` and an independent-copy fallback. Runtime files are never
hard-linked. Workspace packages and root `node_modules` are never shared with
another product or donor checkout. Existing caches and installs are not
rewritten or evicted. Cache entries are retained across Electron upgrades;
cleanup requires an explicit operator decision.

### Installer compatibility

Explicit Electron platform and architecture overrides take precedence before
checksum selection, cache identity construction and executable-path selection.
A differential property test compares PwrGit's download target with the actual
installed Electron `install.js`, including conflicting npm settings. The
linux/x64-versus-darwin/arm64 regression failed before the fix.

If host ZIP tools are unavailable or fail, the installer lazily calls the
Electron package's bundled `@electron-internal/extract-zip` extractor. A warm
extraction cache or completed install does not load that native binding. The
same staging, version check and complete inventory verification apply after
either extraction route. A disposable production-entrypoint test blocks every
host ZIP tool and uses the real bundled extractor, verifies the complete tree,
and confirms cache-hit installs still work when loading the binding is denied.
The no-host-tools case failed before the fallback was added. The APFS probe
also awaits extraction so either extraction route completes before measuring.

### Worktree-only write permissions

Worktree-only write permissions are supported. Download and checksum temporary
files live in an owned directory inside the current Electron package. If the
ZIP cache rejects a write with `EACCES`, `EPERM` or `EROFS`, the installer makes
one attempt with a ZIP cache inside that same temporary directory. Both attempts
retain `@electron/get` checksum validation and download settings. Network and
integrity failures do not trigger this permission fallback. The entry-point
download callback must forward the installer's `tempDirectory` and optional
`cacheRoot` overrides after its default download options.

A readable, verified shared extraction can still be cloned without modifying
the shared cache. When shared storage cannot be used, installation remains
local and may allocate a private runtime. Download scratch and its local ZIP
cache are removed after installation; no existing user cache is removed.

## Verification

The APFS filesystem oracle in `ensure-electron-runtime.test.mjs` was run first
against PwrGit's original `install-electron-binary.mjs`. Its disposable Electron
`install.js` fixture independently extracts the ZIP just as the delegated
installer does. It failed the shared-clone-ID assertion (`236632767` versus
`236632790`). With the cached installer, the same oracle passes and a private
write leaves the other install's bytes unchanged.

Permission regression tests fail against the pre-fix installer, including the
real `@electron/get` test with disposable `chmod 0555` ZIP and extraction
caches (only HTTP is replaced with a local fixture ZIP). A separate native
entry-point test fails for all three permission codes when the callback omits
the override forwarding, even with the helper fixed. These pass with both
changes. Generated permission codes cover `EACCES`, `EPERM` and `EROFS`;
network failures are not retried, scratch is removed, the package lock is
released even under an injected staging-cleanup denial, and PwrGit's explicit and
missing-Electron skip branches remain intact. The real permission oracle runs
on non-root POSIX hosts; cross-platform model and entry-point tests cover the
other host paths.

The focused suite also checks generated platform/architecture combinations,
exact identity field order and key hashing, distinct version/archive identities,
cache content/mode/link corruption, unavailable caches, checksum rejection,
offline completed installs, repair of incomplete files/types, concurrent
processes and recovery after killing the lock owner. The completed-tree import-closure guard also failed before the CI key update,
identifying the missing adapter, and passes after all producer/consumer keys
include both new modules. A native-host production
entrypoint test installs into three project layouts and requires exactly one
cache entry and independent regular files. Setup guards trace both POSIX and
Windows through the production lifecycle chain. Native Windows bootstrap
fixtures run on Windows CI.

### Sparse-checkout audit

PwrAgent review (`84721056b`, PR #3580) found that dependency-cache hits had
masked missing installer imports in sparse source checkouts. PwrGit has no
sparse-checkout lists: all 26 workflow checkouts, including CI and release,
currently select the full source tree. Its completed-tree keys already include
the wrapper, adapter and cache module.

`scripts/electron-install-sparse-checkout.test.mjs` ports the parent's Git
oracle and audits every workflow checkout. It discovers the installer's local
import closure, including the wrapper's side-effect import, then applies the
checkout's patterns to a disposable Git index and tree. It uses Git's actual
cone expansion and non-cone matching, independent of dependency cache hits.
A negative regression case selects only the wrapper and adapter and confirms
that the oracle rejects the missing helper. Future sparse patterns must retain
all discovered imports; no duplicated helper inventory defines success.

### Real cross-product APFS measurement

On 2026-11-10, Node 24.22.1, macOS arm64, the headless probe ran copied
production PwrAgent and PwrGit entrypoints against one existing Electron
44.9.3 release ZIP, substituting only a downloader that returns that ZIP.
PwrGit's locked Electron version was retained. Both use a fresh shared
`PWRAGENT_HOME` inside a disposable probe directory, never the user's cache.
The probe does not launch Electron or operate in the donor checkout.

[Raw allocation report](evidence/electron-runtime-sharing-macos.json) records
`getattrlist` `ATTR_CMNEXT_PRIVATESIZE` and `ATTR_CMNEXT_CLONEID`, file inodes,
hashes and allocation totals:

| Install | Regular files | Private bytes before write |
| --- | ---: | ---: |
| Independent extraction A | 260 | 323,215,360 |
| Independent extraction B | 260 | 323,059,712 |
| PwrAgent entrypoint | 260 | 0 |
| PwrGit entrypoint | 260 | 0 |

The PwrAgent and PwrGit framework clone ID is `236644163`, with distinct
inodes `236646978` and `236647592`. Both framework hashes are
`dd63e2ed3669826c26ce9adaabaff14be544cae0937c36067577eff33f05bbf7`.
A 4096-byte write to PwrGit changes only its hash and allocates 16,384 private
bytes; PwrAgent remains at zero private bytes with its original hash.
Equal content and `du` are not the sharing oracle. Node's copy flag alone is
also measured in the raw report to detect macOS's silently ignored clone flag.

To reproduce, fetch the two PwrAgent scripts (`ensure-electron-runtime.mjs` and
`electron-runtime-cache.mjs`) from the reviewed PR ref with `gh api`, placing
them in a disposable directory. With the `.nvmrc` Node and this worktree's
installed dependencies:

```sh
node scripts/resource-run.mjs node apps/desktop/scripts/probe-electron-runtime-sharing.mjs \
  /path/to/existing/electron-v44.9.3-darwin-arm64.zip \
  .local/cross-product-allocation.json /path/to/fetched/pwragent/scripts
node scripts/resource-run.mjs pnpm exec vitest run \
  apps/desktop/scripts/ensure-electron-runtime.test.mjs \
  scripts/windows-environment.test.mjs \
  scripts/electron-install-sparse-checkout.test.mjs \
  scripts/dependency-cache-workflow.test.mjs
pnpm lint
```

The probe verifies the ZIP against the installed package's release checksum,
requires one cache entry for both products, and deletes only its own fresh
staging directory. Use a matching ZIP if the lockfile's Electron changes.
