# OpenClaw: git-twig versus shipped PwrGit CoW

2026-11-16 follow-up to [the original APFS experiment](2026-11-16-git-twig-cow-results.md),
requested with the public [openclaw/openclaw](https://github.com/openclaw/openclaw)
repository. The source is pinned at
[`410c0dda40702e25263b49b8b7d0786a5e49e366`](https://github.com/openclaw/openclaw/tree/410c0dda40702e25263b49b8b7d0786a5e49e366),
with first parent `4a74c61ae7c438587bc272840d180d16f7c5a283` as the older
revision. The parent differs in 53 files, with 124 insertions and 74 deletions.

The checkout has **65,500 tracked blobs**, including 65,498 regular files
(five empty), two symlinks and 260 executable regular files. Regular-file
content totals 776,199,748 bytes (740.24 MiB). No dependencies were installed,
and no OpenClaw application, build/test script, or repository hook was run.

## Actual native/fallback behavior

OpenClaw's pinned [root attributes](https://github.com/openclaw/openclaw/blob/410c0dda40702e25263b49b8b7d0786a5e49e366/.gitattributes)
start with `* text=auto eol=lf`. They were preserved. This is outside Twig
v0.3.0's native creation contract, even with `core.autocrlf=false`.
`TWIG_TRACE=1` reported `stock Git: request is outside the CoW fast path`
at HEAD. The parent also correctly delegates. These are capability gaps,
not Twig failures; this is **not a measurement of Twig native cloning**.

PwrGit reflink-on did share the real repository's files under those attributes.
The HEAD probe found matching first physical extents for all 65,493 nonempty
regular files and zero private allocation for all 65,498 regular files.
Stock, Twig fallback and PwrGit off shared no nonempty first extents and each
had 921,948,160 private file-data bytes (879.24 MiB). The five empty files
have zero private allocation in every arm, so they are not clone evidence.

At the parent revision, PwrGit shared 65,440 nonempty regular files. Exactly
53 files remained private, matching the 53 paths whose blobs differ from
main's HEAD, with 937,984 private file-data bytes. All five empty files still
had zero private allocation. Stock, Twig fallback and reflink-off again
shared no nonempty first extents. The byte oracle confirmed the parent
contents rather than copying HEAD's versions of those 53 files.

## Method and evidence

The [raw evidence and command](git-twig-cow-openclaw/README.md) use the
existing [harness](git-twig-cow-evidence/run.py) and the same binary pins:
stock Git 2.55.0; Twig v0.3.0 at `112840639a5d80b05d1d5426723be49f2a16dd83`;
and PwrGit Git `2.56.0-dev-pwrgit.4` at
`97dd200ae74c18d4afe94deb03bc79f29b9d774d`. All three binary SHA-256s match
[the earlier pins](2026-11-16-git-twig-cow-results.md#binaries-and-scope)
and are recorded again in the structured results. On/off explicitly sets
`checkout.reflink` on the same custom binary. Twig's PATH uses stock Git.

This is the same M2 Max / 32 GiB / macOS 27.2 host, on a new dedicated
8 GiB case-sensitive APFS sparse image. The source was freshly cloned from
the public URL at the exact revision, with depth two. Its tracked mtimes
were aged and its index refreshed to avoid the known fresh-index donor
exclusion. Umask was `022`, user/system Git configuration was isolated,
`core.autocrlf=false`, and hooks were disabled. Host free space was checked
against the 40 GiB stop threshold.

Each revision/arm uses one warmup plus five measured creates, reversing arm
order on successive rounds. Source and binary bytes were read first.
**Warm caches; page cache was not dropped.** `/usr/bin/time -l` captures
wall/user/system and peak RSS. Creation excludes subsequent full-tree
hashing, status, sharing probes and cleanup. Every verified tree is compared
against stock Git `archive` of its requested commit, including bytes,
executable mode and symlink text. Status/diff are checked separately.

Sharing probes query APFS first physical byte and private allocation for
every regular file, in 256-path batches. Independent cohort allocation uses
`statvfs` on the otherwise idle test image, after `sync` and a 0.3 s settle,
with three retained HEAD children. It includes indexes and filesystem
metadata. No `du` or summed `st_blocks` is used. Private-data reduction is
not freed SSD bytes. Allocation has one cohort per arm, not five repeats.

## Creation time

Median wall seconds, five measured samples after warmup:

| Revision | Stock | Twig (fallback) | PwrGit on | PwrGit off |
|---|---:|---:|---:|---:|
| HEAD | 13.17 | 13.26 | 11.67 | 13.27 |
| Parent | 13.48 | 13.81 | 11.84 | 13.42 |

The HEAD medians put reflink-on about 11% below stock and 12% below the
same binary with reflink off. This is a modest latency difference, not the
large speedup of the earlier byte-heavy synthetic fixture. Individual HEAD
samples in execution-round order were:

| Arm | Wall seconds |
|---|---|
| Stock | 16.12, 12.39, 13.17, 13.22, 12.62 |
| Twig fallback | 19.45, 13.65, 12.87, 13.26, 12.04 |
| PwrGit on | 21.33, 11.67, 11.93, 11.35, 11.46 |
| PwrGit off | 24.08, 23.70, 13.27, 12.58, 12.66 |

The shared host and clear variation across rounds limit speed confidence.
These samples do not establish statistical significance or a general latency
ranking. Twig's fallback time must not be compared as if it had performed
verified native cloning on this tree.

HEAD median process CPU and peak RSS:

| Arm | User s | System s | Peak RSS MiB |
|---|---:|---:|---:|
| Stock | 1.46 | 5.18 | 306.06 |
| Twig fallback | 1.70 | 5.38 | 305.84 |
| PwrGit on | 0.41 | 10.36 | 205.89 |
| PwrGit off | 1.47 | 5.32 | 304.61 |

Reflink-on reduced user CPU and process RSS, but spent substantially more
system CPU. Its lower median wall time is not a CPU-efficiency improvement
on this many-file checkout. Raw user/system/RSS samples for both revisions
are retained alongside wall samples.

## Cohort allocation

Additional allocation for **three simultaneous HEAD worktrees**, after sync:

| Arm | Additional allocated bytes | MiB |
|---|---:|---:|
| Stock | 2,888,024,064 | 2,754.234 |
| Twig fallback | 2,891,247,616 | 2,757.309 |
| PwrGit on | 103,202,816 | 98.422 |
| PwrGit off | 2,889,981,952 | 2,756.102 |

Reflink-on used about **96.4% less additional image allocation than stock**
in this cohort. It still allocated roughly 98 MiB for filesystem metadata
and indexes despite having zero private regular-file data in the per-file
probe. The few-MiB differences among the ordinary-write arms are not a
storage ranking. Shared object storage is standard linked-worktree behavior
in all four arms, not an extra CoW benefit. These observations do not mean
physical SSD space was freed.

## Re-share and correctness

All **61 creates succeeded**. There were **50 full commit-oracle checks**
without a mismatch: the 48 timing/warmup trees, then checks after re-share and
reset. Allocation-only creates were not separately oracle-checked. Every
recorded post-operation status and raw diff was clean.

An additional private HEAD worktree, created with reflink off, had
921,948,160 private file-data bytes. On that unchanged worktree:

| Operation | Wall | Outcome |
|---|---:|---|
| `worktree reflink -n --porcelain -z` | 9.41 s | 65,493 eligible files; 921,948,160 potential private reduction |
| `worktree reflink --porcelain -z` | 43.56 s | 65,493 reshared; 921,948,160 observed private reduction; zero failures |

The seven skips were the two symlinks (`index-entry`) and five empty files
(`no-allocation`). Unlike the earlier contrived-xattr case, apply achieved
the dry-run estimate here. Apply used 0.91 s user / 34.71 s system CPU and
35.89 MiB peak RSS. This is one maintenance operation, not a median benchmark.

Hashing every tracked path before and after re-share found **no byte or
executable-mode changes**. There were 65,493 inode replacements and zero
mtime changes. The independent probe then found 65,493 matching nonempty
first extents and zero private file data. A subsequent reflink-enabled hard
reset preserved the full tracked-tree digest and passed the commit oracle.
No existing production worktree was used for this maintenance test.

## Interpretation and limits

For this unmodified OpenClaw checkout, **PwrGit supplies working-tree sharing;
Twig delegates and supplies none**. Twig can still create the correct ordinary
linked worktree, sharing the object database through standard Git behavior,
but its native storage benefit does not apply to the checked-in attributes.
No attributes were removed merely to make Twig's native path eligible.

The HEAD timing benefit is much smaller than the earlier large-file synthetic
result. Storage and later re-share are the stronger reasons to use the
PwrGit feature for this repository. A clean-source oracle pass here does not
resolve the shipped binary's [previously reproduced stat-invisible mapped-donor
failure](2026-11-16-git-twig-cow-results.md#reproduced-donor-failure-and-mmap-boundary).
Use ordinary checkout/reflink-off when committed-byte guarantees must hold in
the presence of such donors. Re-share retains its documented writable-mapping
boundary on APFS.

These are creation/sharing/maintenance tests, not OpenClaw application tests.
There is no native Twig timing for this tree, no cold-cache measurement, no
Linux run, no concurrent application editing, and no test of unreleased Git.
The source object database is a depth-two clone; a full-history pack layout
could affect ordinary checkout timing. Exact allocation deltas have one
cohort per arm on one fresh test image, and timings come from five samples
on a shared developer machine.

The scratch image was detached after collecting the records. Python syntax
compilation, saved-evidence checks, and repository lint validation accompany
the evidence. The source/configuration assumptions, command arrays, every
timing sample, NUL porcelain and full per-file probe output are retained.
