# Shared Electron runtime extraction cache

PwrGit's `install:electron-binary` command delegates to
`ensure-electron-runtime.mjs`. Desktop `postinstall` runs it before SQLite
staging and the Linux sandbox check. Both Codex setup paths run ordinary
`pnpm install`; Windows bootstraps the exact `.nvmrc` Node and `packageManager`
pnpm with `scripts/windows-environment.ps1`. `ignoreScripts: false` explicitly
keeps workspace lifecycle hooks enabled. Electron remains a devDependency;
production-only deployments and `ELECTRON_SKIP_BINARY_DOWNLOAD` still skip it.

## Shared protocol

The cache is **the same cache as PwrAgent and PwrSnap**, at
`~/.pwragent/cache/electron-runtime/v1`. `PWRAGENT_HOME` overrides the home
containing `cache/electron-runtime/v1` in all three products, including tests.
No PwrGit-specific cache variable or product dimension is added. This affects
only install-time runtime caching; PwrGit's application state locations do not
change. Dependency trees remain independent in every checkout.

`electron-runtime-cache.mjs` is copied unchanged from PwrAgent PR
[pwrdrvr/PwrAgent#3580](https://github.com/pwrdrvr/PwrAgent/pull/3580), head
`776c3c4d04a1b167f1e8d5d818446cf67d7a1a39`. The adapter resolves Electron
relative to this desktop layout and preserves PwrGit's skip behavior.

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
`npm_config_platform`, `npm_config_arch`, `force_no_cache`,
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
OS-confirmed dead-owner recovery; `path.txt` and the installation manifest are
published only after verifying the staged runtime. Legacy or damaged installs
are replaced from a verified source.

macOS uses native `/bin/cp -cRpP` to create independent APFS clone files.
Elsewhere, or when native cloning fails, Node copies with
`COPYFILE_FICLONE` and an independent-copy fallback. Runtime files are never
hard-linked. Workspace packages and root `node_modules` are never shared with
another product or donor checkout. Existing caches and installs are not
rewritten or evicted. Cache entries are retained across Electron upgrades;
cleanup requires an explicit operator decision.

## Verification

The APFS filesystem oracle in `ensure-electron-runtime.test.mjs` was run first
against PwrGit's original `install-electron-binary.mjs`. Its disposable Electron
`install.js` fixture independently extracts the ZIP just as the delegated
installer does. It failed the shared-clone-ID assertion (`236632767` versus
`236632790`). With the cached installer, the same oracle passes and a private
write leaves the other install's bytes unchanged.

The focused suite also checks generated platform/architecture combinations,
exact identity field order and key hashing, distinct version/archive identities,
cache content/mode/link corruption, unavailable caches, checksum rejection,
offline completed installs, repair of incomplete files/types, concurrent
processes and recovery after killing the lock owner. A native-host production
entrypoint test installs into three project layouts and requires exactly one
cache entry and independent regular files. Setup guards trace both POSIX and
Windows through the production lifecycle chain. Native Windows bootstrap
fixtures run on Windows CI.

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
  scripts/windows-environment.test.mjs
pnpm lint
```

The probe verifies the ZIP against the installed package's release checksum,
requires one cache entry for both products, and deletes only its own fresh
staging directory. Use a matching ZIP if the lockfile's Electron changes.
