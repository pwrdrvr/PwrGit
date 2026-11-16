# git-twig and shipped PwrGit CoW: APFS measurements

2026-11-16. This tests the source comparison in
[the pinned research](2026-11-16-git-twig-cow-comparison.md), originally
[PR #607](https://github.com/pwrdrvr/PwrGit/pull/607) at
`8eeb9f2a9e87e67e54edf75630dd57074a0627ff`. That document is copied unchanged.
The source comparison is the starting point; the evidence here adds execution.

A later [OpenClaw follow-up](2026-11-16-git-twig-cow-openclaw.md) applies the
same protocol to a 65,500-path real repository, preserving its attributes.

**Both native paths saved working-tree allocation. Their speed depended on
file shape. The shipped PwrGit binary also reproduced its documented donor
correctness gap: a stat-invisible mmap edit became a new worktree's bytes.**
Twig rejected that clone and correctly delegated to stock Git. Explicit
PwrGit re-share preserved the tested bytes, modes, and mtimes, but could not
recover old blobs from another sibling after main drifted.

## Binaries and scope

| Arm | Executable / source | Version | SHA-256 of executable |
|---|---|---|---|
| Stock | `/opt/homebrew/bin/git` | `2.55.0` | `5f0351f649aa1321345229d5256fc8043517778b134a3b4571ecdc3818f124b2` |
| Twig | Fresh clone of `leostera/git-twig`, tag `v0.3.0`, commit `112840639a5d80b05d1d5426723be49f2a16dd83`; `rustup run 1.95.0 cargo build --release --locked -p git-twig` | `git-twig 0.3.0` | `a1c79097bc8e8defd26ee52b507d7eafad1b397de29af572fb8cac31f47fe9f8` |
| PwrGit on/off | `/Applications/PwrGit.app/Contents/Resources/git/bin/git`; shipped source `97dd200ae74c18d4afe94deb03bc79f29b9d774d` | `2.56.0-dev-pwrgit.4` | `eac6232cb328e1cbefd31e0b346d292d50b204ecac767ab907b30422b0635586` |

PwrGit on and off are **the same binary**, with explicit
`-c checkout.reflink=true` / `false`. Twig uses stock Git on PATH, including
for verification and fallback, with `TWIG_TRACE=1`. The custom Git is invoked
by absolute path. Apple Git is not an arm. Code-sign inspection of the custom
binary returned TeamIdentifier `T44CNHC4UH`; this run did not establish the
certificate chain (`Authority=(unavailable)`). Source/license identity remains
as pinned in the research: Twig MIT, custom Git GPL-2.0-only.

Hardware: Apple M2 Max, 32 GiB, macOS 27.2 build 26B123. This is a shared
developer machine. Fixtures were on one newly created 6 GiB sparse,
case-sensitive APFS image, used only by this harness. Host free space stayed
above 85 GiB, comfortably above the 40 GiB stop threshold. The image was
detached after testing. No Electron windows, production repositories,
installed runtimes, global configuration, or other Git worktrees were changed.
Unreleased alternate-donor and verified-clone branches were not built or run.

## Method and evidence

[Harness and reproduction instructions](git-twig-cow-evidence/README.md),
[all create timing samples](git-twig-cow-evidence/timing-samples.csv), and
[parsed summary](git-twig-cow-evidence/summary.json) accompany this report.
Compressed command logs retain argument arrays, working directories, stdout,
stderr, trace, NUL porcelain, and nonzero subprocess exits. Archive payloads
are represented in logs by length and SHA-256; the harness compares the actual
archive contents in memory.

- Every arm used umask `022`, throwaway global/system Git configuration,
  `core.autocrlf=false`, disabled hooks, and identical source commits within
  each cohort. No user Git config was loaded by the harness.
- Each fixture/revision/arm had one warmup and five measured creates, with
  arm order reversed on successive rounds. Source bytes and binary bytes
  were read before timing. **Warm caches; page cache was never dropped.**
  Creation excludes subsequent oracle reads and first status. `/usr/bin/time
  -l` recorded wall/user/system and peak RSS; its wall resolution is 0.01 s.
- The independent oracle is stock Git `archive` of the requested commit,
  comparing SHA-256 of every tracked regular file, symlink text, and executable
  mode. Status and raw diff are separate checks. Re-share snapshots hash all
  tracked files before and after, including intentionally dirty files.
  A lifecycle rerun additionally captures aggregate digests around every
  hard reset (24 resets), and the small supplement retains individual hashes.
- The standalone [APFS probe](git-twig-cow-evidence/apfs-probe.c) queries
  `F_LOG2PHYS_EXT` and `ATTR_CMNEXT_PRIVATESIZE`. First-extent equality is a
  sharing signal, not a claim that every extent matches; zero private bytes
  supplies an independent whole-file allocation signal. This follows the
  approach of the pinned
  [Git test helper](https://github.com/huntharo/git/blob/97dd200ae74c18d4afe94deb03bc79f29b9d774d/t/helper/test-reflink.c).
  Attribute querying uses Apple's
  [getattrlist API](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html).
- Cohort allocation is `(f_blocks - f_bfree) * f_frsize` from `statvfs`, before
  and after three retained children, each observation after `sync` and a
  0.3 s settle. Children are removed before the next arm's new baseline.
  Logs are outside the image. Deltas include directory/index/filesystem
  metadata. This is one fresh image for the campaign, not a fresh format per
  sample. There is one allocation cohort per arm, not a confidence interval.
  No `du` or summed `st_blocks` is used, and no result means freed SSD bytes.

Fixtures: 4,096 deterministic 1 KiB files; 32 deterministic 8 MiB files
(256 MiB); each plus executable, relative symlink and absolute symlink.
An ancestor/newer pair changes every eighth binary file and renames the
executable. Synthetic source files were aged before indexing to avoid the
unrelated racy-index donor exclusion. A fresh public Twig repository at the
tag has 162 regular tracked files; its parent is the older revision.

The original public clone's fresh index yielded **zero** PwrGit donor clones.
A separate fresh public clone, with mtimes aged and `update-index --refresh`,
yielded 162/162 at HEAD. That controlled follow-up supports a racy-index
exclusion explanation; it is not folded into the original samples. Twig was
native in both public HEAD cohorts. This is a practical storage caveat for a
freshly checked-out donor, even long after its files entered the page cache.

## Creation time

Median wall seconds, five samples after warmup. The public rows below use
the explicitly aged/refreshed source. Both public cohorts are in the CSV.

| Fixture / requested revision | Stock | Twig | PwrGit on | PwrGit off |
|---|---:|---:|---:|---:|
| 4,096 small files / HEAD | 0.57 | 0.56 native | 0.64 | 0.33 |
| 4,096 small files / ancestor | 0.56 | 0.61 fallback | 0.57 | 0.58 |
| 256 MiB / HEAD | 0.17 | 0.86 native | 0.02 | 0.17 |
| 256 MiB / ancestor | 0.18 | 0.19 fallback | 0.04 | 0.18 |
| Public Twig / HEAD | 0.03 | 0.14 native | 0.05 | 0.03 |
| Public Twig / parent | 0.03 | 0.05 fallback | 0.04 | 0.03 |

Byte-heavy HEAD median user/system seconds and peak RSS MiB were:
stock `0.06/0.10, 15.89`; Twig `0.62/0.05, 15.47`; PwrGit on
`0.00/0.01, 8.20`; off `0.06/0.10, 15.84`. Twig's verification reads bytes;
the shipped unconverted PwrGit path does not verify them. Those contracts
matter to interpreting the speed difference. The source description supports
this explanation; timing alone does not isolate which internal step costs it.

Small-file timing varied substantially: Twig's HEAD samples were
`1.28, 1.29, 0.56, 0.56, 0.51` s; stock's were
`0.46, 0.80, 0.57, 0.60, 0.50` s. PwrGit on was
`1.09, 0.68, 0.60, 0.64, 0.60` s. These support no general small-file speed
win. The on/off control also shows that stock-versus-fork differences cannot
all be attributed to cloning. The byte-heavy result is strong for this
warm-cache fixture, not a repository-independent ranking.

## Allocation and sharing

Additional allocated MiB for **three HEAD worktrees**, not their logical
sizes and not whole source repository sizes:

| Fixture | Stock | Twig native | PwrGit on | PwrGit off |
|---|---:|---:|---:|---:|
| 4,096 small files | 54.488 | 4.770 | 5.008 | 54.445 |
| 256 MiB | 768.168 | 0.129 | 0.145 | 768.168 |
| Public, fresh index | 12.371 | 0.336 | 12.371 | 12.371 |
| Public, aged/refreshed index | 12.371 | 0.336 | 0.355 | 12.375 |

These measure linked-worktree data and metadata. Shared object databases are
ordinary Git worktree behavior in every column. Differences of a few KiB
between the clone arms are not a storage ranking.

At HEAD, both native paths shared all 4,097 synthetic regular files or all
33 byte-heavy files (including the executable), confirmed by equal first
physical offsets **and** zero private bytes. Stock/off shared none. At the
ancestor, Twig traced fallback and shared none. PwrGit shared 3,584/4,097
small-fixture files and 28/33 byte-heavy files: exactly the unchanged paths
still available from main. The aged public ancestor shared 149/162 with
PwrGit and none with Twig fallback.

## Correctness and later operations

The main, public follow-up, and lifecycle datasets contain 312 successful
creates and 304 archive-oracle checks, with zero tree mismatches or nonzero
create exits. Allocation-only creates are not all independently verified;
the check count includes subsequent operation checks. This statement excludes
the deliberately adversarial supplement, whose PwrGit mismatch is below.

| Case | Observed result |
|---|---|
| Append, same-size overwrite, overwrite with restored mtime, dirty symlink | All four arms produced committed bytes/links. Twig delegated correctly. A normal restored-mtime write changed ctime, so it does not prove the stronger stat-invisible case. |
| Edit, rename, mode flip, status/diff, dirty hard reset | Expected dirty status/diff, then oracle-clean reset for every arm. |
| Switch ancestor and back | Every arm correct. Twig retained sharing for 3,584 unchanged files; rewritten paths became private. PwrGit on had all 4,097 shared again. Stock/off had none. Twig does not proactively destroy existing clones; its capability gap is restoring rewritten ones. |
| Merge, rebase, local-bare-remote fast-forward pull | Successful, expected trees for each arm. Commands and hashes retained. This tests correctness, not a timed or sharing comparison for every internal merge strategy. |
| Concurrent creates | Two per arm, in both main/lifecycle passes: 16 successes, all oracle-correct. No `commondir` race observed at this low concurrency. This cannot establish absence of the known stock Git registration race. |
| Marker | Config-only reflink-on creates did not create `reflink-source` in the metadata fixture. Later operations kept using the explicit config and default main donor. |

Explicit PwrGit re-share in the lifecycle rerun:

| Target | Reshared | Skipped | Observed private reduction | Apply wall | Tree/mode/mtime changes |
|---|---:|---:|---:|---:|---|
| 4,097 private, unchanged regular files | 4,097 | 2 symlinks | 16,781,312 B | 2.25 s | none |
| Then dirty one file and one symlink | 0 | 3 | 0 B | 0.06 s | none; 4,096 already shared |
| Ancestor, main has newer blobs, sibling has ancestor | 3,584 | 515 | 14,680,064 B | 2.02 s | none |

The first re-share changed 4,097 inodes on APFS, preserved mtimes, and changed
no tracked bytes or modes. The independent probe moved from 4,097 private
files to zero-private for all 4,097. These are private-file-data observations,
not volume-free-space claims. Dirty hard reset afterward restored the commit.

**Drift:** the larger ancestor case left 513 regular files private despite
an old sibling. Switch and reflink-enabled hard reset did not recover them.
An additional literal-move test created both children at the old commit,
moved main to a commit deleting `old-only`, then re-shared, reset, and switched
the child away/back. `stable` shared across main/sibling/child; `old-only`
remained a distinct 65,536-private-byte file in each child. Hashes remained
correct. The sibling's available blob was not selected. Twig has no re-share
command; that is a capability gap, not an executable failure. This tests the
shipped binary only, not either unreleased donor stack.

**Metadata:** native Twig copied the donor's custom xattr and quarantine
xattr. Stock and both PwrGit creation arms omitted them; all had kernel
provenance. Executable `0755` and symlink text were correct. PwrGit creation
gave fresh mtimes; Twig retained the aged donor mtime in this fixture. For an
existing private target with its own custom xattr/quarantine, dry-run reported
61,440 potential bytes; apply reshared only the 4,096-byte executable and
skipped the data file with `metadata-unavailable`. Its bytes and xattrs were
unchanged. This confirms that APFS dry-run can exceed achievable apply, and
does not establish successful arbitrary-xattr/ACL preservation. No ACL or
special-flag test was run.

## Reproduced donor failure and mmap boundary

The oracle property is: **creating a worktree at commit C must produce C's
tracked bytes independently of uncommitted donor edits.** `supplement.py`
holds a 64 KiB file mapped writable, commits earlier writes through that
mapping, then writes another byte through the already-dirtied mapping. Both
mtime and ctime stayed unchanged, while SHA-256 changed. This is the
stat-invisible donor condition documented at the shipped pin.

Reproduced three times, including the initial harness run that later failed
on the unrelated Python xattr API:

- Commit SHA-256: `8ac9c705ea70ab765364d76ed077428a4efd4410505051c27af63d8c3b9304ae`.
- Dirty donor SHA-256: `aea159252ca89e69bdfb62ced949568265058c249496064aaec1ed0342d1a66f`.
- Stock, Twig fallback, and PwrGit off created the commit bytes and were clean.
- **PwrGit on created the dirty donor bytes**, exited 0, and subsequent
  stock status showed ` M data`. This violates the creation oracle, even
  though the limit is documented. It is not merely a status-cache difference.
- Twig trace reported `cloned files do not match the requested commit`,
  then correctly used stock Git. It also reported retained failed staging.

The macOS mapping behavior itself is not a Twig bug or something CoW caused.
The fork's consequential choice is using trusted-stat donor bytes to create
a new committed checkout without content verification. Do not use these
measurements as evidence that an unreleased verification fix works.

A separate writable mapping was held across APFS `worktree reflink`.
Re-share preserved the pathname bytes and replaced its inode. A later write
through the old mapping changed the old inode, while the pathname still had
the committed bytes. This demonstrates the documented descriptor/mapping
boundary of clone-compare-replace. It does **not** force a write between
comparison and rename or establish the probability of that race. Twig has
no equivalent maintenance replacement. Ordinary POSIX rename semantics must
not be mislabeled as a Twig failure.

## Recommendation and confidence

For creating many worktrees **at the current commit**, Twig is useful when
stock-Git compatibility, working-tree allocation savings, and verified
creation matter. Its native scope is narrow; older revisions correctly
delegate and do not get partial sharing. On these fixtures it brought no
reliable speed gain and cost more CPU on large bytes. Its copied xattrs and
retained staging on failed preparation are operational details to account for.

For **repeated switches/resets and maintenance recovery**, PwrGit's per-file
checkout plus explicit re-share supplies capabilities Twig lacks. It was
substantially faster on this byte-heavy creation fixture, shared unchanged
files at other revisions, and restored private files without changing bytes.
It did not regain blobs available only from another sibling, and a freshly
racy donor index could suppress all create-time sharing.

For workflows requiring a new worktree to contain **exactly committed bytes
even with writable mapped donors**, the shipped reflink-on path is unsuitable:
use Twig's verified native path or ordinary checkout/reflink-off. This is the
correctness gap that most constrains recommending the shipped binary. A
future verified-clone build needs this same adversarial oracle before changing
that advice. Maintenance re-share also needs writable mappings/descriptors
quiesced under its documented APFS contract.

Confidence is high in the observed byte mismatch, correct Twig fallback,
partial older-revision sharing, APFS re-share byte preservation, and shipped
single-donor drift limit. Allocation direction is strong for these cohorts;
exact deltas have one sample. Speed confidence is moderate for the large-file
fixture and low for broad generalization from small files on a shared host.
Linux, Windows, cold-cache behavior, high concurrency, crash recovery, sparse
checkout, filters/CRLF/LFS/submodules, and unreleased implementations were not
tested. The Linux kernel was deliberately skipped: these bounded fixtures
already distinguish the contracts without a multi-GiB checkout campaign.

Validation: Python syntax compilation and warning-enabled C compilation
passed; repository `pnpm lint` passed using `.nvmrc` Node `24.22.1`.
No product code was changed. Harness/setup failures are retained separately
in [setup notes](git-twig-cow-evidence/setup.md).
