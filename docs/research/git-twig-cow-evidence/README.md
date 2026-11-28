# APFS experiment evidence

Read [the results report](../2026-11-16-git-twig-cow-results.md) for conclusions
and limitations. These are throwaway-fixture tools, not a CI suite or a
product implementation. They do not require Electron or an existing user repo.

## Files

| File / dataset prefix | Contents |
|---|---|
| `run.py` | Deterministic fixtures; four-arm create timing/allocation; archive oracle; dirty source, lifecycle, re-share, drift, concurrency and mmap-held-across-replace probes |
| `supplement.py` | Tiny stat-invisible mapped-donor oracle; metadata creation/re-share; small reset hashes; literal main-checkout drift |
| `apfs-probe.c` | First physical byte and private allocation per file; no `st_blocks` totals |
| `summarize.py` | Offline parser for the retained JSON, including NUL porcelain summary fields |
| `results1-*` | Original complete campaign: timing, allocation and initial lifecycle probes |
| `public-aged-*` | Separate fresh public clone, explicitly aged mtimes/refreshed index; same create/allocation protocol |
| `lifecycle-*` | Lifecycle-only repeat with automatic full tracked-tree hashes around all 24 hard resets |
| `supplement1-*` | Mmap failure reproduced; then harness stopped because macOS Python lacks `os.setxattr` |
| `supplement2-*` | Corrected xattr CLI; mmap, metadata and small reset probes complete |
| `supplement3-*` | Same corrected probes plus literal move of main to a commit deleting a child's path |
| `timing-samples.csv` | Every create warmup and measured sample from both timing datasets, including CPU and RSS |
| `summary.json` | Compact derived output of `summarize.py` for the three large datasets |
| `lint-output.txt` | Successful `pnpm lint` under Node 24.22.1 |
| `final-checks.txt` | Artifact decoding, compilation, source identity and image-detach checks |
| `setup.md` | Exact setup/run commands, setup failures, and cleanup |
| `SHA256SUMS` | Content hashes of all other retained evidence files |

`*-results.json.gz` are structured records; `*-commands.jsonl.gz` are full
subprocess logs. gzip is used to retain repetitive per-path porcelain and
probe output without making a multi-megabyte text diff. There is no dependency
on the surviving `/private/tmp` paths to read the saved evidence. Those paths
identify the exact executed commands, not reusable data locations.

For example:

```sh
gzip -dc lifecycle-results.json.gz > /tmp/lifecycle-results.json
python3 summarize.py results1-results.json.gz public-aged-results.json.gz lifecycle-results.json.gz
gzip -dc supplement3-commands.jsonl.gz
```

Git archive payloads are compared in memory, with their byte length and
SHA-256 recorded instead of binary archive bytes in the command log.
Regular-file snapshots record an aggregate SHA-256 over sorted path/type/mode/
per-file-SHA-256 entries; symlinks use their text. The small reset supplement
also retains the individual per-file hashes and link text. Source commits,
binary pins and sanitized Git environment are in the structured main records.

## Reproduce on macOS APFS

Choose a new scratch directory and new mount point; the harness refuses an
existing `--root`. Have Rust **1.95.0** installed. Read the pinned Twig Cargo
manifests before building; there are no tracked repository hook scripts to
invoke, and Git hooks are disabled. Do not use another agent's Git checkout.
Check at least 40 GiB free on the host data volume. The fixture image is 6 GiB,
but its backing store grows on the host. Do not run the campaign concurrently
with another workload on that image.

The executed paths and commands are in `setup.md`. With paths adapted:

```sh
git -c core.hooksPath=/dev/null clone --no-checkout https://github.com/leostera/git-twig "$SCRATCH/twig"
git -C "$SCRATCH/twig" -c core.hooksPath=/dev/null checkout --detach 112840639a5d80b05d1d5426723be49f2a16dd83
(cd "$SCRATCH/twig" && rustup run 1.95.0 cargo build --release --locked -p git-twig)
hdiutil create -size 6g -type SPARSE -fs 'Case-sensitive APFS' -volname TwigCoWTest "$SCRATCH/cohort.sparseimage"
hdiutil attach -nobrowse -mountpoint "$SCRATCH/volume" "$SCRATCH/cohort.sparseimage"
clang -Wall -Wextra -O2 apfs-probe.c -o "$SCRATCH/apfs-probe"
python3 run.py --root "$SCRATCH/volume/main" --output "$SCRATCH/main-results" \
  --twig "$SCRATCH/twig/target/release/git-twig" --probe "$SCRATCH/apfs-probe"
python3 run.py --public-only --age-public-index \
  --root "$SCRATCH/volume/public-aged" --output "$SCRATCH/public-aged-results" \
  --twig "$SCRATCH/twig/target/release/git-twig" --probe "$SCRATCH/apfs-probe"
python3 run.py --lifecycle-only \
  --root "$SCRATCH/volume/lifecycle" --output "$SCRATCH/lifecycle-results" \
  --twig "$SCRATCH/twig/target/release/git-twig" --probe "$SCRATCH/apfs-probe"
python3 supplement.py --root "$SCRATCH/volume/small" --output "$SCRATCH/small-results" \
  --twig "$SCRATCH/twig/target/release/git-twig" --probe "$SCRATCH/apfs-probe"
hdiutil detach "$SCRATCH/volume"
```

When running in PwrGit, use `.nvmrc` Node and prefix these heavier Python runs
with `node scripts/resource-run.mjs`, as in the actual commands. Read tool
paths at the top of `run.py`/`supplement.py`: neither installs a Git binary.
Pin and record any replacement stock/custom binary; its results are a new
experiment. The current scripts can run an improved future binary without
asserting that the known failure must continue to exist.

The oracle records mismatches rather than aborting so that adversarial
failures remain inspectable. A zero harness exit is **not** a product pass;
inspect mismatches, hashes, status, traces and subprocess exit fields.
In particular, the mapped-donor PwrGit-on SHA-256 mismatch is a recorded
product failure despite a zero exit from `git worktree add`.

The initial full campaign predates the added automatic reset recorder and
public-index debug field. Neither affects its timed create operation. The
separate lifecycle/public reruns exercise those additions; original raw
records are retained rather than backfilled. The final supplement adds the
literal-drift case after the first corrected supplement run.

The [OpenClaw follow-up](../2026-11-16-git-twig-cow-openclaw.md) uses the same
protocol via `--public-url`, `--public-name`, `--public-revision`,
`--public-depth 2`, `--public-only`, and `--age-public-index`.
`--public-reshare` adds a private child, byte-checked re-share, and hard reset.
The shallow clone pins its revision at clone time so a moving remote branch
cannot change the requested two-commit fixture. Sharing-probe invocations are
batched into 256 paths to stay below macOS's argument-size limit on large trees.
