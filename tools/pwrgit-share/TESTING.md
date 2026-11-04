# Worktree properties and Git oracle

The rule is: source sharing may change allocation, but must preserve Git's
checkout semantics and isolate changes between worktrees. Tests use disposable
repositories, private Git configuration and temporary Cargo homes.

`tests/worktree_property.rs` applies the repository's
[property/model/oracle guidance](../../docs/property-model-oracle-testing.md)
using the test-only `proptest` crate. Every run generates fresh inputs; no seed
is pinned in the test. It prints a replay command and shrinks failing cases.

The generator creates files through Git, then commits another revision with
different attributes. Inputs include text, CRLF and arbitrary binary bytes;
executable modes; spaces, quotes, tabs, newlines and carriage returns in paths;
Unicode; and non-UTF-8 paths on Linux (APFS rejects those names). It also varies
LF/CRLF, ident and filter attributes, core.eol, packed refs, linked/detached
donors, inherited repository overrides, and forced no-CoW fallback.

The state model replays generated edit, stage, reset, revision switch, donor
edit and remove/recreate commands against both the share CLI and ordinary Git
worktrees. After every step it checks:

- File bytes, symlink targets, modes, HEAD, index entries and freshly hashed
  Git status agree with ordinary Git.
- Recipient commands preserve the donor; donor edits preserve the recipient.
- Source files have one link, and successful operations leave no partials.
- Initial clone/checkout counts cover the Git tree; forced fallback clones zero.

There are eight bounded traces per run, each with up to three commands. The
complete CLI and a fresh-index oracle require substantially more subprocesses
than a pure property, so this is deliberately a small real-Git budget. Named
contract examples separately cover each conversion, donor locks, failures,
cancellation, hook parity, large batches and the Cargo freshness gate.

## Avoiding a cached-status oracle

A generated `ident` attribute / recreate / revision-switch trace initially
found identical file bytes and index entries but different cached status.
Ordinary Git can retain expanded `$Id: ... $` bytes when a later revision drops
the attribute without changing the blob, then report clean until its stat
cache is invalidated. That result depends on timing.

The oracle now constructs a private index from the actual index tree before
asking Git for status. Its zero stat entries force Git to hash the worktree,
including staged changes, without refreshing the working index's stat cache.
The named `ident_attribute_switch_compares_bytes_instead_of_cached_clean_status`
test retains this trace and checks the resulting status against independent
Git blob hashes. It does not assert that a cached clean answer is correct.

## Pre-fix validation, 2026-11-04

The new tests were also compiled against the source from `fcbfbe89`, before
the four checkout review fixes, extracted into this workspace's ignored
`target/oracle-pre-fix` directory. Only its test dependency configuration and
the new test file were supplied from the current crate. Both tests failed.

The generated test shrank to two ordinary non-executable text files, no
attributes, native EOL, an ordinary donor, CoW enabled, inherited repository
overrides enabled, and no subsequent commands. The CLI left a different
checkout than ordinary Git. Replay seed: `1793813919953912000`. This establishes
that the model detects the old defect rather than just agreeing with the
current implementation. The existing named regression also checks preservation
of dirty donor bytes and its index in both sharing and fallback modes.
The separate named `ident` case, run without repository overrides, also fails
on `fcbfbe89`: it finds raw `$Id$` where ordinary Git expands the identifier.

The rebased crate passes 24 tests (4 library, 18 contract, 2 property/oracle),
formatting, Clippy with warnings denied, and the release build on this Mac.
The repository's `pnpm lint` also passes after a frozen-lockfile install.
No application or pnpm dependency changes were needed.

Replay a reported seed from this crate directory with a temporary Cargo home:

```sh
CARGO_HOME=/private/tmp/pwrgit-share-build-cargo \
  PROPTEST_RNG_SEED=1793813919953912000 \
  node ../../scripts/resource-run.mjs cargo test --locked --test worktree_property -- --nocapture
```

The pre-fix extraction is disposable and is not committed. APFS allocation and
large-project validation remain documented separately in [BENCHMARK.md](BENCHMARK.md).
