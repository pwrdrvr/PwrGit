# Twig attribute/LFS follow-up and implementation handoff

Inspected 2026-11-18. This updates the interpretation of the
[Nov16 comparison](2026-11-16-git-twig-cow-results.md); it does not relabel its
v0.3.0 results as current Twig behavior.

## Current source

- Released v0.5.0: `bdb2253264205db99cf57dca6af699321f7ef514`.
- Inspected/built main: `ab51be8edcd6bab97592eea74713833dffd72fe6`.
  The binary still prints `git-twig 0.5.0`, but includes **unreleased** changes.
- Scout binary SHA-256:
  `f07c68f220534c51b12095ed5f52cf857bb5b82d4643a8a31a4a902e17146b53`.
  Built with `rustup run 1.95.0 cargo build --release --locked -p git-twig`
  in a fresh isolated public-source clone. No installed binary was replaced.

The pinned [changelog](https://github.com/leostera/git-twig/blob/ab51be8edcd6bab97592eea74713833dffd72fe6/CHANGELOG.md)
and code materially change the earlier capability matrix:

- v0.4 supports common LF attributes, including `text=auto eol=lf`. It derives
  policy from the target index, compares private raw cloned bytes, and lets
  Git write exceptional paths without dropping unrelated sharing.
- v0.5 adds bounded cross-revision donor selection, Git-written builtin
  ident/encoding exceptions, submodule-directory handling and more conversion
  cases. The old claim that Twig only clones current HEAD no longer applies.
- Current main handles missing/replaced donor paths per file, strips inherited
  metadata on macOS, improves partial-clone fallback, and reuses verified stat
  data through a Git-rewritten draft index. Linux cloning is parallelized.
  [RFD0024](https://github.com/leostera/git-twig/blob/ab51be8edcd6bab97592eea74713833dffd72fe6/docs/rfds/RFD0024-verified-index-reuse.md)
  describes the verification/index contract and remaining conversion-policy
  exclusions; this is more than a cosmetic index-cache optimization.

## LFS is still fallback, not native sharing

The current [attribute parser](https://github.com/leostera/git-twig/blob/ab51be8edcd6bab97592eea74713833dffd72fe6/crates/git-twig/src/checkout.rs)
rejects explicitly present external `filter` attributes on regular files for
the whole native request. Ordinary `filter=lfs` therefore delegates to Git.
That can preserve correct LFS behavior when Git and Git LFS are configured,
but is not native LFS sharing or native sharing of the other paths in that
filtered repository. Sparse checkout, conditional includes and relative
attribute-file configuration also retain conservative fallbacks.

Git LFS is an external filter integration, not another EOL setting. Its
[filter-process documentation](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-filter-process.adoc)
includes path inclusion/exclusion rules; its
[configuration](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc)
includes skip-smudge, and LFS extensions can transform output further.
The committed pointer is not necessarily the desired working-tree bytes.
`git archive` of the pointer alone is therefore not a hydrated-checkout oracle.

The implementation handoff uses the **ordinary writer's exact output after
executing the real filter**, including delayed filter-process behavior, then
considers a donor clone only on exact byte match. This preserves the real
filter's invocation and errors instead of assuming a donor's hydrated bytes
are always wanted. It is an implementation direction, not yet a tested fix.

## Fresh local performance scout

Same explicit stock Git 2.55.0 and shipped PwrGit `.4` binaries and hashes as
Nov16. Current Twig main above replaces v0.3.0. This does **not** benchmark
the newer verified custom-Git development stack.

Two scratch fixtures: 1,000 x 1 KiB and 32 x 4 MiB deterministic random files,
each with `* text=auto eol=lf`. Random payloads are predominantly binary-like;
this is not OpenClaw's text/content mix. Source files were aged before indexing.
Isolated Git config, hooks disabled, umask022, source/binaries read before
timing. One warmup and five measured repeats per arm, alternating forward and
reverse arm order, using `/usr/bin/time -l`. Host APFS on the same shared M2
Max; page cache not dropped. No fresh-image cohort allocation was collected.

| Fixture / metric (median s) | Stock | Twig main | PwrGit on | PwrGit off |
|---|---:|---:|---:|---:|
| 1,000 files: create | 0.08 | 0.30 | 0.17 | 0.07 |
| 1,000 files: create + first status | 0.10 | 0.30 | 0.22 | 0.09 |
| 128 MiB: create | 0.19 | 1.31 | 0.03 | 0.12 |
| 128 MiB: create + first status | 0.75 | 1.31 | 0.85 | 0.66 |

Combined medians are computed from each sample's sum, not by adding medians.
First status was measured immediately after create, before the independent
byte oracle. Twig first-status medians rounded to 0.00s at time-l's 0.01s
resolution; that means below resolution, not zero work. Its trace confirmed
1,001 and 33 verified file clones with zero Git-written paths. Independent
first-extent/private-allocation probes were retained for a representative file.
All 48 creates matched every regular-file SHA-256 from Git archive, with clean
first status. These fixtures have no symlinks or executable-mode variations.

Twig did not beat shipped custom Git in either metric on these fixtures.
The combined metric narrows the large-file difference substantially, and
outliers occurred (stock large-file create included 1.49s). This is a small
scout, not a current OpenClaw head-to-head or a deployment decision.
[Script](git-twig-cow-20261118/scout.py),
[samples/pins](git-twig-cow-20261118/results.json.gz), and
[raw commands](git-twig-cow-20261118/commands.jsonl.gz) are retained.

Upstream's pinned [README](https://github.com/leostera/git-twig/blob/ab51be8edcd6bab97592eea74713833dffd72fe6/README.md#benchmarks)
publishes v0.4 OpenClaw at 8.80s versus stock8.58s
and a kernel cohort faster than stock. Those are its measurements, not ours;
different hosts, commits and cohorts prevent comparing8.80 directly against
our earlier11.67. Unreleased verified-index changes also postdate that table.
No evidence here establishes that current Twig matches or beats our newer
verified implementation on OpenClaw.

## Bundling feasibility

An invisible, pinned helper is feasible in principle: these clients own the
creation call site and can invoke a packaged executable without changing the
user's shell PATH or requiring a separate install. Twig is MIT; packaging
still needs version/platform pins, signatures, update handling and notices.
PwrAgnt already explicitly resolves bundled Git and Git LFS and constructs a
consistent helper environment in `apps/desktop/src/main/bundled-git.ts`.
A Twig integration must retain that Git/helper/LFS selection, credentials,
config, errors and cancellation/process ownership.

It is currently a creation alternative, not a full replacement for our Git:
later switch/reset/merge/rebase/pull would not gain per-file cloning through
Twig, and its experimental adoption supports Linux dedupe but explicitly
does not live-replace APFS files. Keeping custom Git for those operations
while using Twig for creation would still require shipping the fork. Native
LFS handling is not a reason to adopt Twig yet because it still delegates.

Recommendation: reuse upstream's tested ideas and assess a bundled-helper
prototype as an option, but do not replace the runtime on these results.
Benchmark current Twig release/main against the verified custom build, with
creation plus first status and actual LFS hydration, before choosing. Attribute
and LFS correctness belongs in the custom-Git work now; application integration
and distribution changes are a separate reviewable step.

## Implementation ownership

The requested GPT-6.2-Sol / high / auto / fast-off thread was created in an
isolated custom-Git worktree. Assigned base
`5ac091a29d960535e1ec6adf318dc444da9a8888` already includes raw cloned-snapshot
verification against Git output, recipient EOL conversion, four alternate
donors and APFS re-share/reset repair. The implementation will extend the
existing filter/ident/encoding exclusions instead of duplicating those stacks.
The old shipped `.4` mapped-donor failure is not evidence that this verified
base still has that failure. The child owns regression/oracle tests and an
independent draft PR; it will not deploy or change either installed app.
