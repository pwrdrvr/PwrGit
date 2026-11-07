# Bounded and strict target seeding on PwrRoute — 2026-11-01

**How these runs were made.** The seeded arms ran through this tool's former `worktree add --seed-target`, which also cloned the tracked source files itself. That source checkout has since been removed in favour of PwrGit's Git runtime (`git -c checkout.reflink=true worktree add`), followed by `pwrgit-share cargo seed`. The Cargo seed code these numbers measure is unchanged. The private-disk column includes the source files, which were shared by the old checkout; native copy-on-write Git shares them the same way, but these PwrRoute numbers were not re-measured with it. Crate counts and test results do not depend on how the source was checked out.

`cargo seed` defaults to bounded mode; `cargo seed --strict` is the stricter rule measured in the next section. Same donor (`git clone --local` of PwrRoute `02bd47fc`, built with `cargo build --workspace` and `cargo test --workspace --no-run`), same toolchain (`cargo 1.97.1 (c980f4866 2026-06-30)`), same method: three runs per arm, each worktree removed completely before the next, cold `cargo build --workspace --locked --offline`, APFS private bytes after `sync`.

| | crates compiled | create (incl. seed) | build | private disk |
|---|---|---|---|---|
| plain `git worktree add` | 549, 549, 549 | 0.15–0.64 s | 300, 332, 274 s | 3.31, 3.30, 3.30 GB |
| `cargo seed --strict` | 139, 139, 139 | 4.1–5.0 s | 692, 137, 197 s | 1.92, 1.95, 1.97 GB |
| `cargo seed` (bounded) | 24, 24, 24 | 5.5, 14.4, 10.1 s | 125, 215, 186 s | 1.16, 1.17, 1.16 GB |

Load average was 40–76 throughout (two VMs and other work), so seconds are noisy; crate counts and bytes are not. The bounded seed published 699 units of 541 packages: 5,802 clones, 638 rewritten dep-info files, 0 copies. 10 units were seeded under the OUT_DIR exception (`unitsSeededWithDonorOutDirPaths`) and 4 under the debug-map exception (`unitsSeededWithDonorDebugMaps`). Packages rejected: 9 workspace, 86 not built, 9 depends-on-rejected, 1 out-dir-not-seeded, 1 unsupported-target. Seed time is 1–3 s more than strict because it clones about 1,800 more files; no recently-used filter is applied.

**Delete the donor (bounded).** A bounded worktree was seeded, then the donor's `target/` was moved out of reach before anything was built in the recipient. `cargo build --workspace` compiled 24 crates and `cargo test --workspace --no-fail-fast` passed 1,283 tests. The names and results are identical to a plain cold worktree.

**Where the donor paths live.** Byte scan of the bounded recipient's `target/debug` after that build, with each hit mapped to its Mach-O section (rlib members included):

| | where | hits |
|---|---|---|
| seeded | `root-output`/`output` text records (Cargo remaps these) | 64 |
| seeded | crate metadata (`lib.rmeta`, `__DWARF,.rmeta`, and bare `.rmeta`): serde, serde_core, thiserror, mime_guess, html5ever… | 29 |
| seeded | DWARF (`__debug_str`, `__debug_line`): rquickjs-sys cc objects in its own `out/`, html5ever | 14 |
| seeded | build-script and proc-macro executables: install names and debug maps | 76 |
| recipient-built | debug-map symbol strings in workspace binaries, naming rquickjs-sys's `out/` C sources | 68 |
| recipient-built | `__DWARF,__debug_line` in gpui_base (inlined html5ever/markup5ever code) | 8 |
| recipient-built | `__TEXT,__cstring` in gpui_base's object files: the panic location `…/build/html5ever-<h>/out/rules.rs` | 4 |

Every occurrence is metadata or debug information except the last row. That string is runtime-visible, but only as text: a panic inside html5ever's generated tokenizer, inlined into gpui_base, would print the donor's path. Nothing in PwrRoute opens a file at those paths. The gate's `gate-outdir` fixture covers the case that does: generated code that opens `concat!(env!("OUT_DIR"), "/data")` reads the donor's copy while it exists and fails loudly once it is gone.

# Strict registry-only target seeding on PwrRoute — 2026-11-01

This section is the strict rule, now `cargo seed --strict`.

The donor is a `git clone --local` of PwrRoute at `02bd47fc`, built once with `cargo build --workspace` and `cargo test --workspace --no-run`. The real checkout was never modified. Toolchain: `cargo 1.97.1 (c980f4866 2026-06-30)` from PwrRoute's `rust-toolchain.toml`, on macOS APFS, with the release CLI at this branch's head. Arms alternated plain/seeded, and each worktree was removed completely (`git worktree remove --force`, `rm -rf`, `prune`) before the next run. Each build is a cold `cargo build --workspace --locked --offline`. "Private" is APFS private data bytes per unique inode, measured after `sync`. On APFS, Cargo itself clones incremental output into `deps/`, so per-file private bytes can be 0 even for files built locally.

| | crates compiled | create (incl. seed) | build | private disk |
|---|---|---|---|---|
| plain `git worktree add` | 549, 549, 549 | 0.15–0.64 s | 300, 332, 274 s | 3.31, 3.30, 3.30 GB |
| `cargo seed --strict` | 139, 139, 139 | 4.1–5.0 s | 692, 137, 197 s | 1.92, 1.95, 1.97 GB |

Build times are unreliable here. The host's load average was 50–76 during these runs, from two VMs and other work, and the 692 s run overlapped the peak. Crate counts and private bytes do not depend on load. The seed published 521 units of 420 packages: 3,987 clones, 480 rewritten dep-info files, 0 copies.

After run 3 of each arm, `cargo test --workspace --no-fail-fast` passed the same 1,283 tests in both worktrees, with an identical list of names and results. In an earlier run, one seeded `cargo test` failed in `singleton::tests::fake_browser`. Rerunning that test binary 200 times, interleaved, failed 3/200 in a seeded worktree and 3/200 in a plain one. These are timing-sensitive socket tests under load, unrelated to seeding.

**Why 139, not the 9 the unscanned prototype reached.** The prototype cloned every non-workspace unit without looking inside. With the byte scan required, these are rejected:

- Registry crates that `include!(concat!(env!("OUT_DIR"), …))`: serde, serde_core, thiserror, ref-cast, mime_guess, markup5ever/html5ever and others. They keep the donor's absolute OUT_DIR path in their rlib/rmeta (source map and debug info). The path also spreads into code inlined downstream: gpui_base's rlib names html5ever's OUT_DIR.
- On macOS, build scripts and some proc macros (derive_more-impl, rust-embed-impl, proptest-macro, gpui-pre*) carry debug-map paths to donor `deps/*.rlib`.
- rquickjs-sys's cc-built objects.

The dependency fixed point then rejects 116 more packages. An uncommitted experiment that allowed every OUT_DIR and donor `deps/` path inside artifacts compiled 29 crates in 63 s, with 1.21 GB private. Bounded mode (previous section) is the narrower version of that rule that shipped as the default.

Without the unit-level edge check, the fixed point also over-rejected. `cargo metadata`'s resolve lists optional edges the build never uses (cc → jobserver), and following them gave 193 crates compiled and 2.56 GB.
