# OpenClaw follow-up evidence

This dataset extends [the original APFS comparison](../2026-11-16-git-twig-cow-results.md)
to the public [openclaw/openclaw](https://github.com/openclaw/openclaw) repository.
See [the OpenClaw report](../2026-11-16-git-twig-cow-openclaw.md) for results.

The shared [harness](../git-twig-cow-evidence/run.py) retains the same four
binaries/configurations and measurement protocol. No OpenClaw package install,
application, build script, test script, or hook is executed. Root attributes
are preserved. The source index is explicitly aged/refreshed, as in the prior
public-index follow-up. Binary SHA-256s match the earlier experiment.

| Evidence | Meaning |
|---|---|
| `source.json` | Public source pins, tracked sizes/modes, root attributes, and parent diff |
| `results.json.gz` | Full create, oracle, allocation, sharing and re-share records |
| `commands.jsonl.gz` | Raw subprocess arguments, stdout, stderr, time-l and Twig trace |
| `summary.json` | Offline output from `summarize.py` |
| `timing-samples.csv` | Every warmup/measured create sample, including CPU and RSS |
| `validation.txt` | Final checks, lint and image-detach outcome |
| `lint-output.txt` | Successful repository lint under Node 24.22.1 |
| `SHA256SUMS` | Checksums of the other evidence files |

Sharing-probe invocations use 256-path batches to avoid macOS's argument-size
limit. No per-file allocation is summed into a false cohort total: image
allocation comes from `statvfs`; summed private size is a separate signal.
Five empty regular files have zero private allocation even under ordinary
checkout, so they do not count as positive clone evidence.

The exact command, from the assigned PwrGit worktree, was:

```sh
source ~/.nvm/nvm.sh
nvm use --silent
node scripts/resource-run.mjs python3 docs/research/git-twig-cow-evidence/run.py \
  --public-only --age-public-index --public-reshare \
  --public-url https://github.com/openclaw/openclaw --public-name openclaw \
  --public-depth 2 --public-revision 410c0dda40702e25263b49b8b7d0786a5e49e366 \
  --root /private/tmp/pwrgit-openclaw-20261116/volume/run1 \
  --output /private/tmp/pwrgit-openclaw-20261116/results1 \
  --twig /private/tmp/pwrgit-twig-20261116/twig/target/release/git-twig \
  --probe /private/tmp/pwrgit-twig-20261116/apfs-probe
```

The fresh image was made with
`hdiutil create -size 8g -type SPARSE -fs 'Case-sensitive APFS' -volname OpenClawCoWTest`,
then mounted with `hdiutil attach -nobrowse` at the path above. A separate
fresh `--depth 2 --no-checkout` public clone was used only to inspect and pin
the source. The actual benchmark source was freshly cloned from the public
URL with `--revision <pin> --depth 2`, not copied from a user's checkout.

Read compressed results without a surviving scratch directory:

```sh
python3 ../git-twig-cow-evidence/summarize.py results.json.gz
gzip -dc commands.jsonl.gz
```

The earlier synthetic donor/mmap failure remains separate evidence; this
follow-up does not intentionally dirty OpenClaw's donor or test an unreleased
Git binary. Creation timings exclude subsequent full-tree hashing, status,
sharing scans, and cleanup. The original first-status timing caveat therefore
still applies.
