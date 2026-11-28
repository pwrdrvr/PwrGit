# Execution notes, 2026-11-16

Assigned worktree:
`/Users/huntharo/.codex/worktrees/mwjfpnl7/PwrGit`.
Scratch root: `/private/tmp/pwrgit-twig-20261116`.

## Research and build

```sh
git fetch origin docs/git-twig-cow-comparison
git show 8eeb9f2a9e87e67e54edf75630dd57074a0627ff:docs/research/2026-11-16-git-twig-cow-comparison.md
/opt/homebrew/bin/git --version
/Applications/PwrGit.app/Contents/Resources/git/bin/git --version
rustup toolchain list
/opt/homebrew/bin/git -c core.hooksPath=/dev/null clone --no-checkout https://github.com/leostera/git-twig /private/tmp/pwrgit-twig-20261116/twig
/opt/homebrew/bin/git -C /private/tmp/pwrgit-twig-20261116/twig -c core.hooksPath=/dev/null checkout --detach 112840639a5d80b05d1d5426723be49f2a16dd83
```

The first sandboxed fetch exited 255 because the assigned worktree's external
Git metadata did not permit writing `FETCH_HEAD`. The authorized retry with
the required filesystem access exited 0. No other worktree was operated in.

The two Cargo manifests were read, and tracked files were searched for
`build.rs`, `.cargo/config.toml`, and hook scripts before building. The binary
crate depends on `anyhow` and `libc`, using the locked workspace versions.
No repo hooks were run. Build working directory was the scratch Twig clone:

```sh
rustup run 1.95.0 cargo build --release --locked -p git-twig
```

Exit 0. The Twig build was never installed into Homebrew or another runtime.
All three binary hashes are retained in `results1-results.json.gz` and the
report, and were unchanged in the lifecycle/public follow-up pins.

## Image and harness

The first image command exited 1:

```sh
hdiutil create -size 6g -type SPARSE -fs APFSX -volname TwigCoWTest /private/tmp/pwrgit-twig-20261116/cohort.sparseimage
```

Output: `hdiutil: create failed - Invalid argument`. The supported filesystem
name worked:

```sh
hdiutil create -size 6g -type SPARSE -fs 'Case-sensitive APFS' -volname TwigCoWTest /private/tmp/pwrgit-twig-20261116/cohort.sparseimage
hdiutil attach -nobrowse -mountpoint /private/tmp/pwrgit-twig-20261116/volume /private/tmp/pwrgit-twig-20261116/cohort.sparseimage
clang -Wall -Wextra -O2 docs/research/git-twig-cow-evidence/apfs-probe.c -o /private/tmp/pwrgit-twig-20261116/apfs-probe
```

All exited 0. The attach returned `/dev/disk15s1` for the mounted filesystem.
hdiutil also printed its create/attach deprecation warnings. A sandboxed
`diskutil listFilesystems` probe failed because it could not use
DiskManagement; it was not required after the corrected hdiutil command.

Each run used the following prefix, from the assigned PwrGit worktree:

```sh
source ~/.nvm/nvm.sh
nvm use --silent
node scripts/resource-run.mjs python3 docs/research/git-twig-cow-evidence/run.py \
  --root /private/tmp/pwrgit-twig-20261116/volume/run1 \
  --output /private/tmp/pwrgit-twig-20261116/results1 \
  --twig /private/tmp/pwrgit-twig-20261116/twig/target/release/git-twig \
  --probe /private/tmp/pwrgit-twig-20261116/apfs-probe
```

Exit 0. Later invocations used the same prefix, Twig and probe arguments:

| Script / extra flags | `--root` suffix under `volume/` | `--output` suffix under scratch | Exit |
|---|---|---|---:|
| `run.py --public-only --age-public-index` | `public-aged` | `public-aged` | 0 |
| `run.py --lifecycle-only` | `lifecycle` | `lifecycle` | 0 |
| `supplement.py` (initial xattr implementation) | `supplement1` | `supplement1` | 1 |
| `supplement.py` (xattr CLI correction) | `supplement2` | `supplement2` | 0 |
| `supplement.py` (plus literal drift) | `supplement3` | `supplement3` | 0 |

Initial supplemental failure, after completing the mapped-donor experiment:

```text
Traceback (most recent call last):
  File ".../docs/research/git-twig-cow-evidence/supplement.py", line 102, in <module>
    os.setxattr(file, 'com.pwrgit.cow-test', b'private fixture metadata')
AttributeError: module 'os' has no attribute 'setxattr'
```

This is a harness portability error, not a product result. The corrected
script uses `/usr/bin/xattr`. Original partial results and commands are kept.
Twig's nonzero internal verification in the adversarial case is reported by
its trace; its outer command correctly succeeds via fallback. Other executed
nonzero subprocesses and deliberate inspection probes remain in raw logs and
are not silently promoted to passes.

## Repository validation and cleanup

Initial shell Node was 24.14.1; `.nvmrc` requires 24.22.1. Repository install
and lint used the latter through `source ~/.nvm/nvm.sh && nvm use`:

```sh
pnpm i --frozen-lockfile
pnpm lint > /private/tmp/pwrgit-twig-20261116/lint.log 2>&1
python3 -m py_compile docs/research/git-twig-cow-evidence/run.py docs/research/git-twig-cow-evidence/supplement.py docs/research/git-twig-cow-evidence/summarize.py
```

Install and lint exited 0. No minimum-release-age or license exceptions were
added. Python/C validation is recorded with the final evidence checks. The
image was detached after preserving results:

```sh
hdiutil detach /private/tmp/pwrgit-twig-20261116/volume
```

Scratch backing image/source files may remain for follow-up inspection; no
mount is left active. The harness never touched another thread's Git source
checkout, the installed app, managed runtimes, or global Git configuration.
