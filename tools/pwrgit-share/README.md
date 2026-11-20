# pwrgit-share

MIT, copyright 2026 PwrDrvr LLC. One Rust library and one CLI that clone a
donor worktree's third-party Cargo build units into a new worktree's private
target, so the new worktree does not recompile its registry and git
dependencies. It does not create worktrees, and it shares no other build
output and no `node_modules`.

## Where it fits

1. **Git creates the worktree.** PwrGit's Git runtime shares unchanged source
   files with the main checkout when `checkout.reflink` is on
   (`git -c checkout.reflink=true worktree add ...`; Settings › Git › In use
   › Copy-on-write checkout), and Maintenance › Clones re-shares them later.
   This tool never registers, checks out or resets a worktree.
2. **`pwrgit-share cargo seed`** then fills the new worktree's empty `target/`
   from the donor's, before that worktree's first build. It is optional: if it
   skips, Cargo builds everything as usual.

```sh
git -c checkout.reflink=true -C /repo worktree add -b feature /repo-feature HEAD
pwrgit-share cargo seed --from /repo/target --to /repo-feature/target --json
pwrgit-share cargo seed --strict --from /repo/target --to /repo-feature/target --json
pwrgit-share probe --json /repo-feature
pwrgit-share measure --json /repo-feature/target
```

Build it from this directory with `cargo build --locked --release`; the
pinned toolchain is Rust/Cargo 1.94.1. The library exports `cargo_seed`,
`probe` and `measure`, with serializable result structs; `Error.code` is the
CLI exit code.

`--from` and `--to` are Cargo target directories, each next to its
workspace's `Cargo.toml`. A repository with several Cargo workspaces, or one
outside the repository root, needs one call per workspace.

## What gets seeded

Only units of packages whose `cargo metadata` source is `registry+`,
`sparse+` or `git+` **and** whose manifest lies under the recipient's resolved
`CARGO_HOME` (`registry/src` or `git/checkouts`). The second condition matters
because a vendored or directory-replaced source still reports `registry+`.
Workspace, path, `[patch]`-to-path and vendored packages are never candidates.
Neither are top-level outputs, `incremental/` or lock files.

Each seeded unit is cloned whole: the fingerprint directory, its `deps/`
artifacts (rlib/rmeta, proc-macro dylib, `.d`, unpacked `.o`), and
`build/<pkg>-<hash>` for build-script compile and run units. Every file is a
copy-on-write clone (macOS `clonefile`, Linux `FICLONE`) that keeps its mtime,
except the rustc `.d` files, which are rewritten (see below) and keep theirs.
Nothing is copied or hardlinked, and a filesystem that cannot clone reports
`cow-unavailable`.

## The donor-path scan

Every staged byte is scanned for the donor's root, which covers its target
path. A unit that names the donor is rejected, along with its whole package.
By fixed point, so is every package whose units were built against a rejected
or unbuilt package, judged by the extern names in the unit's own fingerprint
(`cargo metadata`'s resolve also lists optional edges the build never used).

In every mode, the allowed donor paths are those Cargo or rustc rewrite. A
build script's `root-output` is its old OUT_DIR, and Cargo uses it to remap
that OUT_DIR in `output`; the gate checks the recipient's link line for this.
Rustc's `deps/*.d` may name the unit's own outputs and OUT_DIRs, and these are
rewritten to the recipient's target. A proc-macro dylib may carry its own path
as its macOS install name.

`cargo seed` defaults to **bounded** mode, which adds two exceptions for
seeded artifacts only:

1. A donor path that is exactly `<donor target>/<profile>/build/<pkg>-<hash>/out[/...]`
   is allowed, provided that build-script run is seeded too. Its staged `out/`
   must also be verified at seed time to hold the same files and bytes as the
   donor's. Without that, the unit is rejected (`out-dir-not-seeded`) and the
   fixed point follows. This is the serde, serde_core and thiserror case: they
   `include!` generated OUT_DIR code, and their rlibs keep that path.
2. Mach-O debug-map strings (`N_OSO`, read from the symbol table) that point
   at donor `deps/` or the unit's own build dir are allowed, but only inside
   build-script and proc-macro executables. These run during the build and
   never reach a final binary.

Any other donor path is still rejected, including the donor workspace root
and workspace or path packages' OUT_DIRs.

**Residual effect of bounded mode:** for generated code in seeded third-party
crates, backtraces, panic locations and debugger source paths point into the
donor's target. This includes code inlined into workspace crates; on PwrRoute,
one panic-location string in gpui_base names html5ever's generated
`rules.rs`. The content is identical while the donor exists. Generated code
that opens its own `OUT_DIR` at runtime reads the donor's copy, and fails once
the donor is gone; the gate demonstrates this. Reports count these units as
`unitsSeededWithDonorOutDirPaths` and `unitsSeededWithDonorDebugMaps`.
`--strict` seeds none of them. Strict and bounded both run in the gate.

## Safety checks

- **Donor locks.** Seeding holds nonblocking shared locks on every donor
  profile's `.cargo-lock`, `.cargo-build-lock` and `.cargo-artifact-lock`. A
  donor that is building right now is a skip (`donor-busy`), never a wait.
- **Never into an existing target.** It stages privately and publishes with
  an atomic no-replace rename, so a target Cargo already created, even an
  empty one, is a skip (`target-exists`). Seeding after the checkout is
  safe because no workspace unit is ever seeded; the gate builds the donor
  after the recipient's checkout and checks no workspace unit comes out Fresh.
- **Same toolchain, Cargo home and config.** Toolchain identity
  (`rustc -vV`, `cargo --version`) is read in both directories with
  `RUSTUP_TOOLCHAIN` cleared, so each directory's `rust-toolchain.toml`
  governs; the two must match. `RUSTFLAGS`, wrappers,
  `CARGO_BUILD_*`/`CARGO_TARGET_*`/`CARGO_PROFILE_*` overrides, Cargo configs
  that differ between the worktrees, configs that name either worktree, and
  configs that set rustflags, rustc, target/build dirs, `paths` or
  `[unstable]` are all skip reasons.
- **Proven Cargo only.** Only exact `cargo --version` strings that passed
  `src/gate.rs` are enabled; every other version reports
  `fingerprint-unproven`. No public flag or environment variable bypasses
  that list.

None of these conditions is an error: the result is `unitsSeeded: 0` with a
`reason` (`donor-busy`, `target-exists`, `toolchain-mismatch`,
`env-override`, `config-differs`, `metadata-unavailable`, ...). `copyCount`
is always 0; `rewrittenCount` counts the regenerated `.d` files.

Staging uses private `<name>.<pid>.<sequence>.pwrgit-share-partial`
directories. Failure or cancellation removes this process's partials. It
never sweeps someone else's partials, runs `cargo clean`, or touches the donor
or Cargo home. `SIGINT` and `SIGTERM` request cleanup at the next subprocess or
file boundary; embedders can call `cancel()`.

## Output

All command results are JSON on stdout, including without `--json`; errors
are JSON on stderr. Exit codes: 0 for a seed or an honest skip, 1 for an I/O
failure, 2 for usage, 130 for cancellation.

`probe` reports whether a directory's filesystem can clone (`cow`).
`measure.logicalBytes` sums regular-file lengths without following symlinks.
For a seeded target, counts come from the `.pwrgit-share.json` record the seed
wrote; later builds are not tracked. Elsewhere they are 0. `measure` labels
allocation `not-distinguishable`: neither `du` nor `st_blocks` proves sharing.

Users may install sccache or Kache separately for compiler reuse. This tool
never configures or spawns them, sets a wrapper, or edits global Cargo config.

## Tests

Run `cargo test --locked`, `cargo fmt --check`, and
`cargo clippy --locked --all-targets -- -D warnings`. Tests create disposable
repositories and temporary Cargo homes, and never read the user's.

- **The freshness gate** (`src/gate.rs`) builds a local registry and a
  `file://` git dependency inside its own `CARGO_HOME`. It creates each
  recipient with Git's own `git -c checkout.reflink=true worktree add`, then seeds
  it, and uses a cold build as the oracle. Registry units must be Fresh in the
  recipient with the donor's target hidden. Each negative fixture must
  recompile: `CARGO_MANIFEST_DIR`/`CARGO_BIN_EXE_*` tests, `include_str!` from
  outside the package, absolute `rerun-if-changed`, a registry rlib embedding
  a donor path and its dependent, and a vendored in-repo source. The
  recipient's test results must survive corrupting and then deleting the
  donor, and a seed after the donor rebuilt must leave every workspace unit
  compiling. It runs both modes under each toolchain in
  `PWRGIT_SHARE_GATE_TOOLCHAINS` (default `1.97.1`).
- **PwrGit's Git.** Point `PWRGIT_SHARE_GIT` at the runtime's `bin/git`
  (staged by `apps/desktop/scripts/stage-runtime.mjs`) and the gate also
  requires every recipient's source files to be clones of the donor's (APFS
  clone IDs) and checks an edit in one worktree never reaches the donor.
  Without it, `git` on PATH makes ordinary checkouts. CI's macOS job stages
  the pinned runtime and sets it.
- **The fixed point** has a property test against an independent
  graph-reachability oracle over generated dependency graphs
  (`fixed_point_rejects_exactly_what_reaches_a_rejected_package`). It fails
  if every metadata edge is followed (the bug fixed in fd68b375) or if the
  rejection loop stops after one pass.
- **The CLI contract** (`tests/contract.rs`) covers usage errors, busy-donor
  locks, symlinked donors, toolchain mismatches and the mode flag.

[BENCHMARK.md](BENCHMARK.md) records the PwrRoute measurements and their
limits.
