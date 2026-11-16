# git-twig versus PwrGit copy-on-write clones

Research handoff, 2026-11-16. This document records what each side implements
at the pins below. It does not treat an advertised clone as the same mechanism,
and it does not rank them. Empirical timing and byte checks are the next
owner's job. Hypotheses in the original request stay hypotheses until those
tests.

## Pins

| Side | What was read | Pin |
|---|---|---|
| Tweet | `https://x.com/leostera/status/2122320765530124479` | 2026-11-16 13:27:55 GMT. Author `@leostera`. Text points at `https://twig.leostera.dev`. Reply `2122342418355769789` points at `https://github.com/leostera/git-twig`. |
| git-twig product | tag `v0.3.0` | `112840639a5d80b05d1d5426723be49f2a16dd83` (2026-11-16 release). |
| git-twig `main` | shallow clone plus `v0.3.0..HEAD` | `c4e85fbf11cf15d57a21061e28f98a6c4ad9fae5`. Differs from the tag only in `README.md` and `Formula/git-twig.rb`. Behavior under test is the tag. |
| PwrGit app source | this worktree, detached | `64907c806f127ca6439b650cc19212d331b2a440` (`chore(release): prepare v0.59.5`). |
| Installed PwrGit.app | `/Applications/PwrGit.app` | `CFBundleShortVersionString` `0.59.3`. Bundled Git is already `.4`. |
| Shipped custom Git | `apps/desktop/custom-git-runtime.json` and the app's `Contents/Resources/git/pwrgit-build.json` | `2.56.0-dev-pwrgit.4`, source `97dd200ae74c18d4afe94deb03bc79f29b9d774d`, tag `refs/tags/pwrgit-source/2.56.0-dev-pwrgit.4`. Signed `Developer ID Application: PwrDrvr LLC (T44CNHC4UH)`. Binary: `/Applications/PwrGit.app/Contents/Resources/git/bin/git`. `git worktree -h` lists `reflink`. Bundle `etc` has no `checkout.reflink` force. |
| Fork checkout that must stay untouched | `/Users/huntharo/github/git` | `master` at `fb255012ac` when inspected. Other agents own worktrees on reflink branches. Read-only `git show` / `git log` only. |
| Stock Git on this Mac | explicit paths | Homebrew `/opt/homebrew/bin/git` `2.55.0` (no `worktree reflink`). Apple `/usr/bin/git` `2.54.0 (Apple Git-157)` (no `worktree reflink`). |
| Machine | local PwrAgent instance `pwr_490f7727-674e-43d9-b9ee-be8387f39819` | Apple M2 Max, 32 GiB, macOS 27.2.0, APFS. About 87 GiB free on the data volume at inspection. Not an idle machine. |

Upstream base of the shipped Git commit is `a018953688f1b10bddf91bff8747068f5f4746a4`
(`git describe` on that commit: `pwrgit-source/2.56.0-dev-pwrgit.4`). The
implementation commits sit on top of Git 2.56-era history. License of that
tree is GPL-2.0 only (`COPYING`). PwrGit itself is MIT. git-twig is MIT.

Build recipe for the shipped macOS Git, from the app's `pwrgit-build.json`:
dugite-native-derived recipe revision `f8b57055dc8812a77843ff7e3aaf6d067ba2e070`,
source archive sha256 `cc43c266b9bfd72626fd41fd5394b41edfb9eab4514a38183ac8842034739021`,
`NO_RUST=1 NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1`, SHA1_DC plus Apple CommonCrypto,
Git LFS 3.7.1. Source pull requests named by the pin: huntharo/git #2, #3, #5,
#10, #11. PR #11 (`reflink: allow OS provenance to differ during APFS
re-sharing`) was still open at inspection, head `97dd200ae74c18d4afe94deb03bc79f29b9d774d`,
base `perf/apfs-metadata-queries`. The running app already contains that
commit.

`~/Library/Application Support/PwrGit/git-runtimes` was empty. The product
binary in use on this Mac is the copy inside `PwrGit.app`, not a separately
downloaded managed runtime.

## Identity

The tweet's product is **Twig**: the `git twig` external subcommand from
`leostera/git-twig`, homepage `https://twig.leostera.dev`. It is not a Git
fork and not a library other programs link. The workspace crate `git-twig`
(version `0.3.0`, Rust 1.95, edition 2024) is the binary. `twig-bench` is a
separate benchmark harness. Git discovers `git-twig` on `PATH` as
`git twig`. It does not replace a built-in.

PwrGit is a desktop Git client. Copy-on-write behavior lives in the custom
Git binary. The app's job is to select that binary, turn `checkout.reflink`
on, and run `git worktree reflink` during Maintenance › Clones. Stock Git
has neither switch. Calling the app and the fork the same layer would hide
that split.

| | Twig `v0.3.0` | PwrGit path at the pins above |
|---|---|---|
| Product | `git twig` CLI plus the site | Electron app driving a Git fork |
| Clone engine | Rust program beside Git | C inside `huntharo/git` |
| License | MIT | App MIT. Git GPL-2.0-only. Dugite-native recipe MIT. Git LFS has its own license in the bundle. |
| OS | Native path: macOS and Linux. Elsewhere the process delegates to `git worktree`. Release archives: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`. No Linux arm64 archive in the `v0.3.0` release. | Checkout reflink and `worktree reflink` are compiled for macOS and Linux. Windows is disabled in the design notes. `custom-git-runtime.json` ships darwin-universal, linux-arm64, linux-x64. Changelog: Windows keeps its previous Git runtime. |
| Filesystems, native | macOS APFS (`clonefile`). Linux Btrfs or reflink-enabled XFS (`FICLONE`). Typical ext4 delegates. | Design: APFS; Linux btrfs, XFS, bcachefs, overlayfs. Windows and cross-filesystem: ordinary write. Positive bcachefs/overlayfs coverage is explicitly not claimed by the measurement note. |
| Git required | 2.40+ on `PATH` for bookkeeping, verification, and fallback | The feature is the Git binary. App default `gitReflinkCheckout` is `true` (`GENERAL_DEFAULTS` in `packages/shared/src/protocol.ts`). It applies only after a probe sees `checkout` support. User and repo config still override the generated system config. Nothing is written into the user's Git config. |

## What is actually shared

Both create an ordinary **linked** Git worktree. The object database, refs,
and common Git directory are shared the way `git worktree add` already
shares them. That saving is not Twig's and not the fork's. Neither design
uses object alternates as the working-tree mechanism. Neither hardlinks
working-tree files to the source. Untracked and ignored files are not
copied. A later write breaks sharing for the bytes that write touches, and
the other copy keeps the old bytes. That is normal copy-on-write, not a
sandbox.

What each side adds:

**Twig, native path only.** It clones the source checkout's working-tree
files for the commit that is currently `HEAD`, into private staging, verifies
them, then lets Git register the worktree with `--no-checkout` and installs
the staged tree. Staging is `$GIT_COMMON_DIR/twigs/staging/<private-dir>`.
A successful command deletes only that invocation's staging. Failures keep
it. macOS bulk-`clonefile`s each tracked top-level directory
(`CLONE_NOFOLLOW | CLONE_NOFOLLOW_ANY`), clones root files the same way,
recreates root symlinks, then deletes anything in the clone that is not in
the commit and chmods to the caller's umask. Linux walks only the committed
inventory and `FICLONE`s each regular file. The finished worktree's index is
a new `read-tree` of that commit, not a copy of the source index.

**PwrGit Git, per file, on later commands too.** When `checkout.reflink` is
effective, checkout-like commands (`checkout`, `switch`, `reset`, `restore`,
`merge`, `rebase`, `worktree add`, and the rest of the checkout writer) try
to clone a regular file from another worktree that already has that blob.
The donor is `--reflink-source`, else the per-worktree
`worktrees/<id>/reflink-source` marker, else `checkout.reflinkSource`, else
the main worktree. Linux uses `FICLONE`. macOS uses `fclonefileat`. A miss
uses the ordinary object-database writer for that file. Empty files are
written normally. `git worktree reflink` is a separate pass over an existing
worktree: it tries to make private files share extents with the donor again,
without changing which bytes the worktree has.

So Twig's extra saving is "the new worktree's tracked files were cloned from
this checkout's current `HEAD` files." PwrGit's extra saving is "each file
whose blob is already present, clean, in a donor worktree can be cloned at
creation and again later." Files that do not match a donor are full private
copies in both designs.

## Twig creation contract

Source: `crates/git-twig/src/lib.rs`, `native.rs`, `snapshot.rs`,
`staging.rs`, `tree.rs`, and RFD0001, RFD0003, RFD0010–RFD0013 at the pin.
`git twig new` is rewritten to `git worktree add` before Git sees it.
`git twig add` is rejected. Other subcommands (`list`, `remove`, `move`,
`lock`, `unlock`, `prune`, `repair`) are passed to Git.

Native preparation runs only when all of these hold. Any miss delegates to
`git worktree` before registration:

- Platform is macOS or Linux.
- `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, and
  `GIT_COMMON_DIR` are unset.
- The command is `new -b <branch> <path> [<revision>]` or
  `new --detach <path> [<revision>]`. No extra arguments. A missing `-b` /
  `--detach` delegates, because Git would infer a branch name.
- `<revision>` (default `HEAD`) resolves to the source checkout's current
  `HEAD`. Any other commit delegates the **entire** checkout.
- Not sparse. `core.autocrlf` is unset or `false`. `core.symlinks` is not
  `false`.
- No submodule (`160000`) entries.
- No `filter`, `working-tree-encoding`, `ident`, `text`, `eol`, or `crlf`
  attribute set to anything other than `unspecified` or `unset`, on any
  path. One such path delegates the whole tree.
- No effective `reference-transaction` or `post-index-change` hook, including
  Git config-defined hooks. `post-checkout` still runs, after the registrar
  lock is dropped.
- Destination does not exist. Its parent is a directory. Git metadata and
  that parent are the same filesystem (`st_dev`).
- `clonefile` / `FICLONE` and the later hash check succeed.

Verification is Git, not a private hasher: a temporary index, `read-tree` of
the commit, `update-index --really-refresh` with fsmonitor and sparse
disabled and `core.filemode=true` / `core.symlinks=true`, then
`diff-files --quiet`. A dirty source, including a same-size edit whose mtime
was restored (`core.ignorestat=true` in
`same_size_dirty_bytes_with_restored_mtime_are_not_inherited`), must not
become the new worktree. The test expects the committed bytes. RFD0001 is
explicit that this checks the staged result; it does not claim the source
was snapshotted atomically. A racing source can fail verification. Failure
before registration delegates to Git. Failure after registration keeps the
partial worktree and the staging directory. There is no automatic cleanup of
older staging.

Registration of native creates takes an exclusive lock on
`$GIT_COMMON_DIR/twigs/registration.lock` so two Twig processes do not
observe a half-written `commondir`. Stock Git creators do not take that
lock. Their own README records a concurrent `commondir` registration race in
plain Git during one benchmark. That race is Git's, observed while Twig was
measuring, not a Twig file-content bug.

Symlinks are recreated with `symlink(2)` from the source link text, not
cloned as files. Directory and file modes come from `0666` / `0777` probes
masked by umask, then `chmod`. The code does not strip extended attributes
after `clonefile`. Apple's `clonefile` copies the source file's data and,
with the flags Twig passes, its clone metadata. Whether quarantine, ACLs,
flags, and `com.apple.provenance` survive is an open measurement, not a
claim from a comment in this repo. `chmod` during normalize can change
ctime and may change mtime. Destination mtime is therefore not specified to
match a normal Git checkout. The new index is built after the files are in
place, so a following status uses those stats. RFD0010 still calls out a
large first-status cost on the kernel cohort as future work.

## PwrGit checkout and re-share contract

Source of behavior: `Documentation/technical/reflink-checkout.adoc`,
`Documentation/technical/worktree-reflink.adoc`, `Documentation/config/checkout.adoc`,
and `Documentation/git-worktree.adoc` at `97dd200`, plus the app call sites
`apps/desktop/src/main/git/dugite.ts` and `worktree-reshare.ts`. Those
documents describe the shipped tree. They are design notes with measurements,
not an independent audit of every line of `reflink-checkout.c`.

Creation and later checkout:

- A donor must be a stage-zero regular file of the requested blob, not
  skip-worktree, intent-to-add, or remove. It must be on the same filesystem
  and support the clone primitive.
- The donor index is read read-only. Eligibility uses `ie_match_stat()` with
  valid/skip-worktree/fsmonitor ignored and racy entries treated as dirty.
  Only the executable bit may differ. If `core.checkStat=minimal` or
  `core.trustCtime=false`, the donor is declined. There is no extra content
  hash to replace those checks.
- Unconverted clones are **not** read back or hashed. The design note states
  the consequence directly: a same-size edit that does not change the stat
  fields Git trusts, or a write through an already-dirtied shared mmap that
  does not update timestamps, can be copied. That is a real difference from
  both ordinary checkout and from Twig's create-time hash. It is not a
  generic macOS hazard that only the other tool has. Ordinary Git has the
  same stat-trust limit for "is this file clean?"; the fork additionally
  uses a trusted-clean donor as the bytes of a new file.
- EOL-only CRLF output is the exception: the clone is compared with the
  recipient's ordinary converter, then discarded on mismatch. Filters,
  `ident`, working-tree encodings, and LFS smudge stay on the ordinary
  writer. A clean LFS file can still be re-shared later without invoking
  LFS, because re-share does not invent new checkout bytes.
- After a successful clone, checkout records the new file's real stat.
  Mode, owner, and timestamps are those of a new write. The note says the
  APFS primitive resets mode from umask, strips inherited xattrs except
  kernel-managed `com.apple.provenance`, and resets birth, mtime, and atime.
- Sparse entries, symlinks, and gitlinks use ordinary checkout. A sparse
  source only donates files it has. Parallel checkout workers clone and
  return stats; the parent updates the index.
- `--reflink` on `worktree add` writes the source marker so later
  `switch` / `reset` / `rebase` / `pull` keep trying. `--no-reflink`
  disables only that initial checkout. `checkout.reflink=false` disables
  later cloning even if a marker exists, except that the `add --reflink`
  command's own initial checkout still clones. The app turns the config on
  by writing `checkout.reflink=true` into its generated system config for
  the bundled Git, or by prefixing `-c checkout.reflink=true` when an
  installed Git is selected. It does not pass `--reflink` itself on every
  `worktree add`; with the config on, the Git config is what enables
  cloning. Confirm that in the child's command log rather than assuming the
  marker file appears for app-created worktrees. A command-line test of the
  Git binary should set `-c checkout.reflink=true` explicitly and also record
  whether `reflink-source` was written.

Re-share (`git worktree reflink`), including the pass after a successful
`reset --hard` when reflink is effective:

- Operates even when `checkout.reflink` is false. Does not recurse into
  submodules and does not turn the config on.
- Skips missing, non-regular, sparse, unmerged, intent-to-add, and
  hardlinked targets. Fully shared files are detected from allocation
  metadata and not read.
- Preserves the target's existing bytes, including a historical LF or CRLF
  representation that today's attributes would not recreate. It does not
  reconvert.
- Linux: `FIDEDUPERANGE`, in place, bounded to 16 MiB ranges. The inode
  stays. A prefix can be shared before a later range differs.
- APFS: public clone APIs need a destination that does not exist. The
  engine clones into a private temporary directory, compares that clone with
  the opened target, copies metadata with `fcopyfile`, verifies
  mode/owner/times/xattrs/ACLs, then renames. Inode and ctime change. The
  index is updated under the index lock with the replacement's real stat.
  `com.apple.provenance` may differ; every other xattr, including
  quarantine, must match. Special flags and set-id files are skipped.
  Dry-run does not attempt the metadata copy, so an apply can still skip a
  file the dry-run counted (`metadata-unavailable`).
- `reset --soft`, `reset --mixed`, and a no-op checkout/switch do not run
  this repair. Initial `worktree add` suppresses a second repair scan via a
  private child environment variable.
- Failures warn. They do not roll back a completed reset. Exit status of
  `worktree reflink` is nonzero for operational failures and zero when every
  path was shared or skipped.
- Writable mmap of a working-tree file, or a writable descriptor held across
  the APFS rename, is outside the supported contract. The note's scratch
  probe observed a dirtied mapped page that did not change the captured
  mtime/ctime; rename published the old bytes while the old inode kept the
  new writes. Read-only mappings of packfiles are out of scope. Linux
  in-place dedupe is not claimed to have this rename race. Do not describe
  that APFS limit as something Twig does, and do not describe ordinary Git
  racy-stat or mmap behavior as caused by cloning.

App "clonify":

- Maintenance › Clones runs `git worktree reflink` on linked worktrees the
  app knows about, two at a time inside one repository
  (`RESHARE_WORKTREE_CONCURRENCY`). It can first fast-forward the main
  checkout when that checkout is on its default branch and the fast-forward
  is clean. A main checkout on another branch is left alone. Missing or
  locked worktrees are not passed to Git.
- The one-time offer dry-runs `git worktree reflink -n` per profile. The UI
  is required to say "now shared", never "freed". `observed-private-reduction`
  is private file data that stopped being private. It is not `df` free space.
- This is not a scan of every repository on disk. The original "clonify all
  my repos" hypothesis matches this maintenance action for repositories
  PwrGit has linked, and only there.

## Drift, other revisions, and clone groups

These were hypotheses, not findings, until the source was read.

**Twig does not re-establish sharing later.** After `git twig new`, the
worktree is a normal Git worktree. `checkout`, `reset`, `merge`, `rebase`,
and `pull` are whatever Git is on `PATH`. Stock Git rewrites files and
drops the clone. Twig has no command that finds donors again.

**Twig does not natively clone a different starting revision.** The whole
operation becomes `git worktree add`. Content is then a normal checkout from
the object database. It does not partially share the files that happen to
match `HEAD`.

**Twig does not keep a clone-group record.** Coordination files under
`twigs/` are a registration lock and staging directories. There is no
donor list and no restoration when the main checkout moves.

**Shipped PwrGit re-shares only from the selected donor, usually main.**
If main no longer has that blob, or the donor file fails the stat check,
the file is skipped (`no-donor` in the app's wording: "differ from the main
checkout"). Files main still holds can be cloned. Clean files that are
already shared stay shared when main later changes other paths. A dirty
target is left unchanged, including untracked and ignored files. That is
source-proven for `97dd200`. It is not "recover the original clone set from
any worktree that still has the old bytes."

**Unreleased, not the product under test.** Do not build or edit these
checkouts; other agents own the worktrees.

| Commit | Branch observed | What the message says | Shipped? |
|---|---|---|---|
| `20ef99ba7ee2f242339d4ab25118031131b382fa` | `fix/reflink-alternate-donors` | After the automatic donor fails, try up to four other same-filesystem worktrees, in administrative id order. Explicit marker/config/CLI selection stays single-source. Adds regressions described as clone-group preservation. Also stacks symlink-leading-directory rejection, index reload under the APFS repair lock, and raw snapshot verification (`394423e837`, `efcdb7b32a`, `3c0ffa1ea6`). | No. Four commits ahead of `97dd200`. |
| `63aff8256985835b4d46e02593e7c99468a5cbd3` on `feat/worktree-reflink-v2` (`5ac091a29d`) | separate stack based later than upstream `fb255012ac` | "share verified worktree files with bounded donors": verify each clone against ordinary checkout output, at most four automatic alternates, preserve unchanged clone groups. | No. Different line from the binary in `PwrGit.app`. |
| `8e6340c0b7` | `fix/macos-mmap-stat` | "read-cache: fix checkout and mmap test regressions" | No. Not evidence that mmap bugs are unique to either product. |

The hypothesis that "we preserve and recover clone sets even when main has
drifted from the worktree's start" is therefore **unresolved for the
shipped binary**, and **claimed by unreleased commits** that this research
did not re-test. The next owner should test `97dd200` behavior, and may
describe the unreleased commits as leads. Reproducing them means a new
isolated worktree of `huntharo/git` at that commit, never the worktree
another agent already has.

## Published numbers, as claims

Twig's README table is generated from
`bench/results/readme.json`. Each cell is batch creation time / additional
disk, and creation excludes first status. Their own
`bench/results/readme-details.md` limits how far those cells travel:

| Cohort | Their `git worktree` | Their `git twig` | Notes they print |
|---|---|---|---|
| Workers starter, 100-way | 1.94 s / 6.0 MiB | 6.41 s / 3.7 MiB | 3 rounds. Host APFS timing. Allocation on images. 6 tracked files. |
| git-twig repo, 100-way | 4.90 s / 53.0 MiB | 10.13 s / 7.1 MiB | Includes failed Git attempts (2). Older per-file Twig binary, not the directory-clone release. |
| Axo, 100-way | 4 m 40 s / 3.0 GiB | 2 m 19 s / 165 MiB | One round. Same older binary caveat. |
| Linux kernel, 10 sequential | 3 m 15 s / 18.3 GiB | 4 m 32 s / 549 MiB | One round. Case-sensitive APFS image. Directory-clone release `cf9b046`. First status median 1.91 s vs 18.36 s. |

The site says "up to 97% less space." The kernel cell is about that ratio
(`549 / 18763`). It is one cohort, one round, sequential, on an image. The
same table shows Twig slower to create on three of the four rows. Axo is
the row that is faster, on one round, with a binary they say is not the
directory-clone release. None of this is a comparison against
`checkout.reflink`.

PwrGit's own note at `97dd200` measures re-share, not Twig. On a 2048 ×
64 KiB fixture, private recovery on APFS cost about 1.9–2.1 s median versus
about 13 ms for a no-op `reset --hard`. A second pass over already-shared
files still paid a metadata scan (about 50–60 ms) and cloned nothing. They
state there is no speed claim against those controls. Allocation went from
the full private size to zero private file data in that fixture; they
explicitly refuse to call that freed volume space.

## Correctness caveats to test, not assume

| Topic | Twig `v0.3.0` | Shipped PwrGit Git | Stock Git |
|---|---|---|---|
| Create at `HEAD`, clean source | Native clone plus hash verify, or fallback | Per-file clone if stat-clean donor, else object write | Object write |
| Create at other commit | Full fallback | Share only paths whose blob the donor still has | Object write |
| Dirty source, visible | Fallback; committed bytes | That file uses the object writer | Object write |
| Dirty source, stat-invisible | Hash verify rejects it on the native path (tested in-repo) | Design says the donor can be copied. Must be reproduced, not inferred | Object write does not see the donor |
| Later `checkout` / `merge` / `rebase` / `pull` | Stock Git on `PATH` | Clones again when a donor matches | Rewrites |
| `reset --hard` of unchanged private files | No re-share | Repair pass when reflink is on | Rewrites only what the reset updates |
| Explicit re-share of a group of repos | None | `git worktree reflink` via Maintenance, per linked worktree | None |
| Main drifted, blob lives only in another worktree | No | Shipped: no-donor. Unreleased alternate-donor commits exist | n/a |
| Symlinks | Recreated from source link text, then verified | Ordinary checkout | Ordinary checkout |
| Modes | Git `100644` / `100755` plus umask. Set-id is not a tree mode Twig keeps | Recipient index mode. Re-share skips set-id and special flags on APFS | Git's rules |
| xattrs / ACLs | Not stripped in Twig's code after `clonefile`. Measure. | Checkout strips inherited xattrs except provenance. Re-share preserves copyable xattrs and ACLs and allows provenance to change | New files typically have none |
| mtime | Not specified to match Git's new-file mtime. First status on the kernel cohort was much slower in their data | New-file timestamps on create. Re-share preserves the target's mtime across APFS replacement and records the new inode's stat | New-file timestamps |
| Hardlinks inside the source tree | Directory `clonefile` gives new inodes for hardlink aliases (their RFD0010 probe). Confirm. | Re-share skips a hardlinked target | n/a |
| Cross-filesystem | Delegate before registration if metadata and destination differ | Ordinary write, skip on re-share | Ordinary write |
| Crash / kill | Staging kept; registered partial worktree possible | Ordinary Git checkout crash behavior, plus a private temp dir during APFS re-share | Ordinary |
| Concurrent creators | Native Twig creators serialize registration only | Normal Git index lock on the worktree being written. Re-share is serial in the repair pass. App runs two worktrees at a time | Known `commondir` race under high concurrency, per Twig's benchmark note |
| Submodules, sparse, smudge, `autocrlf` | Whole-command fallback | Per-file ordinary writer for filters and encodings. Sparse donates only present files. `autocrlf` is not a Twig-style whole-command veto; EOL comparison exists for CRLF output | Native implementation |
| Windows | No native path | Disabled | Native implementation |

Unsupported Twig inputs are capability gaps when they fall back and the
fallback checkout is correct. They are product failures only when the
fallback is wrong, partial, or reported as native (`TWIG_TRACE=1` is the
backend signal). A harness that expected native CoW on ext4, on a different
commit, or without `-b`/`--detach` has tested the wrong contract.

## Feature matrix

Legend: **proven** means the pinned source or in-repo test says it.
**claim** means README, site, or a measurement note. **hypothesis** means
not established.

| Statement | Class |
|---|---|
| Twig is `leostera/git-twig` `v0.3.0`, an external `git twig` command, MIT | proven |
| Native Twig shares working-tree bytes via `clonefile` or `FICLONE`, and shares objects only because the result is a linked worktree | proven |
| Native Twig requires the new commit to be the source checkout's current `HEAD`, with an explicit `-b` or `--detach` | proven |
| Native Twig verifies staged bytes with Git's index refresh and `diff-files` | proven |
| Twig re-shares on later Git operations, or restores sharing after main moves | proven absent |
| Twig is faster than `git worktree` | claim, and their own table contradicts it for three of four README rows. Axo is one faster observation |
| "Up to 97% less space" | claim, matching their kernel allocation cell, not a general result |
| PwrGit's user-facing CoW is `checkout.reflink` plus `git worktree reflink` in Git `2.56.0-dev-pwrgit.4` / `97dd200` | proven |
| The installed app binary reports that version and `worktree reflink` | proven on this Mac, 2026-11-16 |
| App default is the switch on, without editing the user's Git config | proven in source. Whether this machine's settings file has flipped it was not read |
| Unconverted PwrGit clones trust Git's stat cache and can copy a stat-invisible donor edit | proven as a documented limit. Reproduction is still required |
| `git worktree reflink` compares target bytes (APFS) or uses kernel dedupe (Linux) and leaves dirty files alone | proven in the design note and the app's fixture test description. Re-run on the installed binary |
| Maintenance can re-share every linked worktree and fast-forward clean default-branch mains | proven in app source |
| Shipped Git recovers a file from a non-selected worktree after main drifts | proven absent at `97dd200`. Claimed in unreleased `20ef99ba7e` |
| PwrGit is faster or more correct than Twig | hypothesis |
| Generic macOS mmap/stat trouble is caused by Twig or by our cloning | hypothesis, and the wrong shape: the shipped APFS re-share note describes a rename race under writable mmap; Twig does not do that replacement; ordinary Git stat-trust is older than both |

## What was not available

- `https://twig.leostera.dev` is a client-rendered page. A fetch returned the
  title only. The site source at the pin (`sites/twig.leostera.dev/src/App.tsx`)
  and the live `https://twig.leostera.dev/llms.txt` were readable. `llms.txt`
  matches the bundled skill and calls the tool a prototype, not a sandbox.
- GitHub issues: one issue, #1, closed, "core: add verified Linux reflink
  worktrees." No open issues. Pull-request discussion beyond that issue body
  was not reviewed.
- The 52-commit history was not re-read commit by commit. The pin's Rust
  sources and RFD0001, RFD0003, and RFD0010–RFD0013 were.
- crates.io was not opened. The formula, `llms.txt`, and the GitHub release
  say `0.3.0` is the published crate.
- No test in this research executed Twig or either Git. Linux behavior is
  from their RFDs and CI description only.
- Unreleased fork commits were read as subjects and messages, not as full
  diffs.
- Private benchmark manifests cited inside the Git note
  (`/private/tmp/worktree-reshare-01a1a279/full-results.json`) were not
  opened.

## Fair test plan for the next owner

Run on this Mac, host APFS, three explicit binaries:

1. Stock: `/opt/homebrew/bin/git` (`2.55.0` unless `git --version` has
   changed; record the new string).
2. Ours: `/Applications/PwrGit.app/Contents/Resources/git/bin/git`
   (`2.56.0-dev-pwrgit.4`, source `97dd200…`). Always pass
   `-c checkout.reflink=true` for the "on" arm and `=false` for the control.
   Do not point `GIT_CONFIG_SYSTEM` at the user's real config. Use a
   throwaway `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`.
3. Twig: build the tag, do not `curl | sh` and do not `brew install` into
   the user's Homebrew prefix.
   `rustup run 1.95.0 cargo build --release --locked --manifest-path <scratch>/Cargo.toml -p git-twig`
   from a fresh clone of `112840639a5d80b05d1d5426723be49f2a16dd83`.
   Record the binary's sha256. Put **stock** Git on `PATH` when invoking
   Twig so fallback and verification are that Git, and record
   `TWIG_TRACE=1`.

Optional fourth column, only if time remains: the same PwrGit binary with
`checkout.reflink=false`, to separate "custom Git, feature off" from "stock
Git".

Do not use `/Users/huntharo/github/git` or any existing agent worktree as a
build directory. Do not clonify the user's repositories. Do not change
global Git config, the managed-runtime directory, or `PwrGit.app`. The
Sandboxer workflow in this repo is dormant; do not try to provision a
replacement. Throwaway fixtures only, under a new directory in `/tmp` or a
new sparse APFS image you create and detach. Leave the image unmounted when
you stop. If free space on the data volume drops below about 40 GiB, stop
and shrink the fixture.

### Workloads

Keep them small enough to repeat.

- **File-heavy synthetic.** A few thousand small files (their file-heavy
  shape is 4096 × 1 KiB; that is a reasonable start). One commit.
- **Byte-heavy synthetic.** Fewer larger files (their shape 16 × 4 MiB, or
  up to a few hundred MiB total). One commit.
- **Modes and links.** Executable bit, symlink to a tracked file, symlink
  to an absolute path, rename between commits, nested directory.
- **Public small repo, cloned fresh into the scratch image.** The Workers
  starter fixture in their repo is six files; too small to prove speed, fine
  as a public-content smoke. A second public repo of a few thousand files is
  enough. Do not clone a private remote. Do not check out the Linux kernel
  unless the smaller fixtures are done and disk headroom is still large;
  their kernel cohort allocated about 18 GiB for ten stock worktrees.

Operations, same arguments on each arm as far as the tool allows:

1. Create one linked worktree at the source `HEAD` (`git twig new -b …`,
   `git worktree add -b …` with reflink on and off).
2. Create a second worktree at an ancestor commit. Expect Twig to trace
   stock Git. Expect reflink-on to share only blobs the donor still has.
3. Dirty the source (append, same-size overwrite, same-size overwrite with
   restored mtime, dirty symlink) and create again. Compare worktree bytes
   to `git archive` / `git cat-file` of the commit, not to the dirty source.
4. Repeat a create 5 times after one warmup. Alternate arm order. Report
   every sample. Warm means the source checkout and Git binaries have been
   read once. Cold means a freshly mounted image or, if you cannot afford
   that, say "process-cold, page-cache unspecified."
5. In an existing worktree: edit, rename, mode flip, status, diff, stash,
   `reset --hard`, `switch` to another commit and back, merge a one-file
   branch, rebase, pull a fast-forward from a local bare remote.
6. Move the main checkout onto a different commit so some blobs the child
   worktree still has are gone from main, while another sibling worktree
   still has them. Run `git worktree reflink` and a later `switch`/`reset`.
   Record which files become shared. This is the drift hypothesis.
7. Two concurrent creates. Separate Twig's registrar lock from Git's
   `commondir` race. A failed stock registration is a stock Git result if
   the same failure happens without Twig.
8. If you touch mmap: map a worktree file writable, write without an mtime
   update if you can, and see whose checkout copies it. Also hold a writable
   mapping across `git worktree reflink` on APFS. Report it as the contract
   each tool documents. Do not attribute the result to "cloning" in general.

### Metrics

- Wall time, user/system CPU, and peak RSS from `/usr/bin/time -l`.
- Git's own reflink porcelain (`--porcelain -z`) on our binary:
  `reshared`, `already-shared`, `skipped`, `failed`,
  `observed-private-reduction`, `potential-private-reduction`, and reason
  codes. Remember APFS dry-run can over-count what apply will replace.
- Allocation on a **fresh APFS disk image** used for nothing else:
  `statvfs` before and after, with `sync` and a short settle, image
  otherwise idle. That delta includes metadata, indexes, and staging. It is
  the cohort total, not a sum of per-file shares.
- Per file, record logical size and a sharing signal that does not add
  shared blocks into a fake total. `st_blocks` and `du` double-count or
  mis-count clones; do not sum them and do not convert a reduction into
  "bytes freed on the SSD." If you write a tiny `clonefile` / `getattrlist`
  probe, keep it in the harness and cite Apple's `clonefile(2)`. The custom
  Git test helper `t/helper/test-reflink.c` at `97dd200` is a reference for
  what this project already measures; do not compile it inside an occupied
  git worktree.
- Correctness oracle: `git -C scratch archive --format=tar <commit>` or
  `git cat-file --batch` compared to file bytes, symlink targets, and the
  executable bit. Then `git status --porcelain=v1` and `git diff --raw`
  against a clean expected state. Hash before and after every re-share and
  reset. A re-share that changes bytes is a failure even if allocation
  improved.

### Report

Write the results under `docs/research/` or `docs/benchmarks/` in the
PwrGit worktree you were given. Include the three binary versions and
sha256s, the Twig commit, the fixture generator, the exact commands, every
timing sample, the allocation method, and a column for "native / fallback /
not supported." A draft PR may hold the harness and the report. Do not
redesign either product, do not merge, and do not push a new Git runtime.

Recommendation shape, after the numbers exist: which tool to use for
**creating many worktrees at the current commit**, which for **later
checkout and maintenance re-share**, and which correctness gaps are
unacceptable. Separate those three. A storage win with a slower create, or
a faster create that can copy an unseen donor edit, can both be true.
