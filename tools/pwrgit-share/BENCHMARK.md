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
