# Local benchmark — 2026-10-27

**Target result: `unitsSeeded: 0`, `cloneCount: 0`, `copyCount: 0`, `reason: fingerprint-unproven`.** Cargo 1.94.1 recompiles the registry dependency when the vendored source path moves with a worktree. Production seeding is deliberately disabled for every Cargo version until the complete gate passes. Source reflinking works independently.

Machine: `macOS-27.2-arm64-arm-64bit-Mach-O`. Release-mode CLI, pinned `cargo 1.94.1 (29ea6fb6a 2026-03-24)`.

```text
rustc 1.94.1 (e408947bf 2026-03-25)
binary: rustc
commit-hash: e408947bfd200af42db322daf0fadfe7e26d3bd1
commit-date: 2026-03-25
host: aarch64-apple-darwin
release: 1.94.1
LLVM version: 21.1.8
```

Probe: `{"cow":"apfs","detail":"temporary-file clone and independent write succeeded in destination parent"}`.

The disposable fixture contains an 8 MiB tracked data file, a binary, a workspace helper, an excluded path dependency, a vendored registry library with a 262,144-element table, and a local file:// Git dependency. Its Cargo home and vendor/Git repositories are temporary. No registry download, operator Cargo home, global configuration, or user repository was used. Each row is a distinct command; variant builds run sequentially in the recipient and retain earlier outputs. These rows must not be added into a disk-saving total.

Tracked source payload: **8,390,000 logical bytes** in each checkout; the script asserts byte-for-byte equality, clean status, and matching HEAD. The following directory totals also include the `.git` pointer file, whose length differs with each registration name.

| Source run | Seconds | Logical bytes | Source clones | CLI copy operations | Git checkout entries | Free-space delta, noisy bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| source-plain | 0.0429 | 8,390,131 | 0 | 0 | 9 | 8,503,296 |
| source-reflink | 0.2402 | 8,390,133 | 9 | 0 | 0 | 94,208 |
| source-forced-none | 0.0866 | 8,390,137 | 0 | 0 | 9 | 8,470,528 |

The small fixture is faster with ordinary Git checkout. Reflink mode launches Git to validate files; this run establishes isolation and clone capability, not a source speedup. Forced-none is an actual CLI run with `PWRGIT_SHARE_FORCE_NONE=1`: `fallback: git-checkout`, zero clones. Copy counts describe this CLI’s copy primitives, not bytes written by Git or the compiler. No hardlink or full-copy fallback was invoked.

The freshness unit test uses vendored sources **inside each checkout** and the test-only candidate seeder. It renames the donor target away before building the recipient. Cargo reports:

```text
Dirty fixture-registry v1.0.0: the path to the source changed
Compiling fixture-registry v1.0.0
```

A preliminary experiment with a single fixed vendor path outside both worktrees reported Fresh. That narrower case is insufficient: the relocated-source gate fails, and the public command’s zero-unit result is asserted. The rejected candidate is available only inside this crate’s tests; neither CLI flags nor environment variables can enable it.

The following counts use the production no-seed behavior. `registry/Git` contains one registry and one Git unit; `workspace/path` contains the binary, workspace helper, and path-only library. Same-commit seeding returned the zero-unit result above, and the donor target was renamed away before every recipient build. Later Fresh units were compiled in the recipient itself; they are not seed hits.

| Build run | Seconds | Registry/Git Fresh | Registry/Git Compiling | Workspace/path Fresh | Workspace/path Compiling | Newly named file bytes | Unused seeded bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold-donor | 0.6873 | 0 | 2 | 0 | 3 | — | 0 |
| same-commit | 0.5361 | 0 | 2 | 0 | 3 | — | 0 |
| changed-source | 0.1391 | 2 | 0 | 2 | 1 | 214602 | 0 |
| changed-rustflags | 0.4845 | 0 | 2 | 0 | 3 | 11789706 | 0 |
| changed-features | 0.4476 | 1 | 1 | 2 | 1 | 11690388 | 0 |
| second-profile | 0.5140 | 0 | 2 | 0 | 3 | — | 0 |
| branch-switch | 0.1282 | 2 | 0 | 2 | 1 | — | 0 |

Changed source recompiles the binary and retains the recipient’s existing dependency builds. `RUSTFLAGS=--cfg pwrgit_share_probe` recompiles both external units. Enabling `extra` changes the registry library and dependent binary. Old artifacts remain in place; none were cleaned before measuring. “Newly named file bytes” counts paths absent from the previous snapshot, not rewritten bytes or physical allocation. Release is a distinct profile; it compiles every unit and is not counted as shared debug output. The branch-switch row builds the changed-source commit after Git checkout.

| Concurrent run | Combined seconds | A registry/Git F/C | A workspace/path F/C | B registry/Git F/C | B workspace/path F/C |
| --- | ---: | --- | --- | --- | --- |
| concurrent-private-targets | 0.5379 | 0/2 | 0/3 | 0/2 | 0/3 |
| shared-target-baseline | 0.9345 | 1/1 | 2/1 | 0/2 | 0/3 |

Both concurrent builds exited 0 and executed with the expected, different feature-dependent output. The donor rlib SHA-256 stayed unchanged. There is no seeded-rlib isolation claim because production seeded zero units. The shared `CARGO_TARGET_DIR` baseline reported a lock wait: **true**. That baseline is not an offered mode.

Editing and resetting recipient source preserved donor bytes. Source and fingerprint files had `nlink == 1`; Cargo’s own uplifted output links are excluded from that assertion. This checks isolation, not extent accounting. Running the built executables verifies the fixture’s expected outputs; a Fresh count is not a general correctness proof.

Representative `measure --json` results:

```json
{
  "source": {
    "logicalBytes": 8390133,
    "cloneCount": 9,
    "copyCount": 0,
    "skipCount": 0,
    "allocatedBytes": "not-distinguishable",
    "countsOrigin": "recorded initial materialization; subsequent edits not tracked"
  },
  "donorTarget": {
    "logicalBytes": 14338324,
    "cloneCount": 0,
    "copyCount": 0,
    "skipCount": 0,
    "allocatedBytes": "not-distinguishable",
    "countsOrigin": "scan-only; historical operations unknown"
  },
  "recipientAfterSameCommit": {
    "logicalBytes": 14338390,
    "cloneCount": 0,
    "copyCount": 0,
    "skipCount": 0,
    "allocatedBytes": "not-distinguishable",
    "countsOrigin": "scan-only; historical operations unknown"
  },
  "recipientAfterVariants": {
    "logicalBytes": 45559477,
    "cloneCount": 0,
    "copyCount": 0,
    "skipCount": 0,
    "allocatedBytes": "not-distinguishable",
    "countsOrigin": "scan-only; historical operations unknown"
  },
  "secondProfile": {
    "logicalBytes": 7659119,
    "cloneCount": 0,
    "copyCount": 0,
    "skipCount": 0,
    "allocatedBytes": "not-distinguishable",
    "countsOrigin": "scan-only; historical operations unknown"
  }
}
```

APFS allocated/shared byte totals are not reported: `st_blocks` cannot distinguish a clone from a copy. `du` was not used. Free-space deltas above are noisy observations affected by other writes and snapshots, not bytes saved. Operation counts describe initial materialization and do not track later extent splits.

Linux FICLONE is implemented and gated by a real probe, but no Linux/Windows VM was started for this measurement. Ubuntu CI can legitimately return `cow: none` on ext4. Windows is not measured. External/custom target layouts, build-script outputs, proc macros, incremental state, and future Cargo versions have no enabled seed promise.

Reproduce from this crate directory:

```sh
CARGO_HOME="$(mktemp -d)" cargo build --locked --release
python3 scripts/benchmark.py target/release/pwrgit-share
cargo test --locked cargo_donor_independent_freshness_gate -- --nocapture
```

The benchmark script creates and removes only its own disposable fixture. The freshness test asserts both the rejected relocation experiment and the public `fingerprint-unproven` result.


## PwrRoute validation — real project, 2026-10-27

The earlier fixture run was not validation of a large Rust application. This follow-up used PwrRoute commit `e1f276114cf5932f60b74aa1c6da16034990b878`, `cargo 1.97.1 (c980f4866 2026-06-30)` / `rustc 1.97.1 (8bab26f4f 2026-07-14)`, a local `git clone --no-hardlinks` snapshot, and disposable linked worktrees. The original checkout remained clean at its original HEAD, and no target directory was created there. Builds and final CLI checks used an explicitly temporary Cargo home; dependencies were fetched once into it, then all builds and metadata checks ran `--locked --offline`. An initial compatibility probe unexpectedly reached metadata with the inherited default Cargo home before the harness was corrected; no global Cargo configuration was changed.

DiskHound's `native/diskhound-native-scanner/src/clone_attrs.rs` at local commit `0b0209b` identified the stronger APFS attributes to inspect. The independent [apfs-audit.py](scripts/apfs-audit.py) reads `CLONEID`, `CLONE_REFCNT`, `REALDEVID`, `EXT_FLAGS`, `PRIVATESIZE`, and `DATAALLOCSIZE` from the kernel, with no-follow options. It requires matching nonzero clone IDs on the same real device, full-sharing flags, reference counts ≥2, and separate inodes with link counts of 1. Its ordinary-copy negative control and one-byte-write check passed. This is stronger evidence than a clone-operation counter or a free-space delta. The CLI's existing `measure` command still does not query these attributes.

| PwrRoute source observation | Result |
| --- | ---: |
| Tracked regular files | 331 |
| Logical source bytes | 8,794,237 |
| Matching APFS full-clone pairs | 331 / 331 |
| Recipient private file-data bytes | 0 |
| Shared allocated data references | 9,576,448 bytes |
| Plain Git control full-clone pairs | 0 |
| Plain Git control private file-data bytes | 9,576,448 |
| Symlinks checked out by Git | 9 |
| Share-command source creation | 4.5358 s |
| Plain Git source creation | 0.1032 s |

Every regular tracked file's bytes matched the donor and plain control. All regular source entries had `nlink == 1`. A one-byte write to the recipient's largest tracked file changed its clone ID and allocated **16,384 private bytes**, while donor/original/control hashes stayed unchanged. Git reset restored the expected bytes; it wrote an ordinary private copy of that changed file. Editing/resetting the disposable donor also left the recipient unchanged. The zero above is private **file data**, not a claim that the directory/inode metadata costs zero disk space, nor an estimate of volume space freed.

The real project uncovered and fixed two compatibility problems:

- Cargo 1.97 keeps `.cargo-lock` shared and locks `.cargo-build-lock` / `.cargo-artifact-lock` exclusively. The CLI now checks all three, matching [Cargo's upstream change](https://github.com/rust-lang/cargo/pull/16886). A live PwrRoute build now returns exit 3 and creates/registers no new worktree. The regression test holds a shared legacy lock and each new exclusive lock.
- Offline metadata without a platform filter attempted to fetch an uncached Linux-only package on this Mac. Metadata now supplies `--filter-platform <rustc-host>`; the same temporary macOS-only cache succeeds offline. The command-shape regression rejects unfiltered metadata.

| PwrRoute build | Seconds | External Fresh / Compiling | Workspace Fresh / Compiling |
| --- | ---: | --- | --- |
| Donor engine, cold | 126.75 | 0 / 152 | 0 / 1 |
| Recipient engine, cold | 126.34 | 0 / 152 | 0 / 1 |
| Recipient full app, after engine | 419.98 | 89 / 445 | 0 / 6 |

`cargo test --locked --offline -p pwrroute-engine` passed **146 tests in each worktree**. The full `pwrroute-app` GPUI binary compiled successfully in the reflinked worktree. This is compile and engine-test coverage; the UI was not launched. Subsequent Fresh outputs belong to that worktree's own prior engine build, not target seeding.

The seed command returned `unitsSeeded: 0`, `cloneCount: 0`, `copyCount: 0`, and `reason: fingerprint-unproven`. Each cold engine target compiled all **152 external packages**. Cargo target sharing remains disabled: this does **not** deliver the multi-gigabyte Rust artifact reuse discussed in the design. A sampled `oxc_parser` rlib had distinct clone IDs and **12,795,904 private bytes in each target**; the donor hash stayed unchanged during recipient builds. Final target logical sizes were 923,368,145 bytes (donor engine/tests) and 4,181,413,573 bytes (recipient full app/engine/tests). These are logical file-length totals, not unique physical allocation or savings. All 3,721 fingerprint files examined had `nlink == 1`.

The source implementation also remains slower than ordinary checkout on this project: roughly 4.54 s versus 0.10 s, because it invokes Git per file. Source sharing is validated; this run does not establish a speed advantage.

Machine-readable evidence is in [pwrroute-2026-10-27.json](validation/pwrroute-2026-10-27.json). The disposable repositories, targets, and Cargo home were removed after capturing it. The original PwrRoute and DiskHound repositories were read only. The CLI suite now has **15 passing tests**; formatting, Clippy, and both macOS/Ubuntu CI jobs pass.

Reproduce APFS controls with `python3 scripts/apfs-audit.py --self-test`. For a project, create a private `git clone --no-hardlinks` snapshot, make a normal worktree and a share-command worktree from it, then run:

```sh
python3 scripts/apfs-audit.py --donor /temp/snapshot --recipient /temp/shared --control /temp/plain
```

Keep `CARGO_HOME` explicitly pointed at a new temporary directory for every Cargo/share invocation that can query metadata; fetch the selected target's locked dependencies there before offline builds. Use the project's pinned toolchain, and create/remove only these disposable worktrees.
