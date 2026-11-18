# Clone and fork

This guide covers clone and fork against forge instances and how fork remotes are written. It was moved from
[apps/desktop/src/main/git/AGENTS.md](../../../apps/desktop/src/main/git/AGENTS.md).

## Clone and fork reach a forge INSTANCE, not a forge

**Every provider lookup passes the hostname from the request.**
`CloneService` and `ForkService` call `ForgeRepoRegistry.get(kind, hostname)`.
With only the kind it returns the **SaaS** provider, so github.com answers for
`ghe.acme.example`. A slug on both then confirms, clones or forks the wrong
repository, silently. `repo:searchCloneSources` is the one channel that still
cannot pass the hostname.

- Resolving an instance is not permission to use it. Anything that spawns a
  CLI also calls `forgeBlockAt(status, provider.hostname)`, including
  `runClone`'s CLI branch and `fork`, which writes.
- SSH and HTTPS clones are plain git and are deliberately not gated. The
  per-host switch governs the forge, not `git clone`.
- The local-checkout index (`repoKey`) is keyed on the hostname, because two
  instances can host the same slug.

`apps/desktop/src/main/forge/AGENTS.md` has the whole rule, including why a
hostname is never evidence of which forge runs on it.

## A fresh clone of a fork keeps its original through `keepForkOriginal`

`repo:clone` (with `upstream`) and `repo:fork` add the fork's original after
the transfer, through one helper in `fork-remotes.ts`.

- **Read the remotes first.** `gh repo clone` of a fork writes `upstream`
  itself, so a bare `git remote add upstream` failed. A remote that already
  points at the original is kept. If another repository has the name, the
  original goes to `upstream-2`.
- **Main asks the forge again before the transfer.** `CloneService` refuses a
  slug that is not the source's `parent` or `root`, so a renderer cannot get a
  remote written for any slug. If only the remote fails, the clone succeeds
  (`ClonedRepo.upstreamFailure`). An error would offer a retry into the folder
  it just made.

## Forking a checkout in place: add `upstream` first, then re-point `origin`

`ForkService.forkCheckout` forks the checkout's source and points the checkout
at the fork. Nothing is cloned or moved. The remote rewire (`fork-remotes.ts`)
is the whole operation.

**Add the upstream remote, then change `origin`'s URL in place. Never rename
`origin`.** `git remote rename origin upstream` rewrites every
`branch.<name>.remote`. Every branch then tracks the ORIGINAL, and the next
push goes to the repository the user cannot push to. With the correct order,
branches track `origin`, which is now the fork.

- **A separate `pushurl` is re-pointed too.** The fetch URL does not decide
  where a push goes. `SshRemoteRecovery` deliberately *keeps* a custom push
  URL, because it changes how you reach the same repository. This changes
  which repository you push to.
- **An existing remote is never overwritten.** `planUpstreamRemote` reuses a
  remote that already points at the original, else takes `upstream` or a
  suffixed variant. The user may have configured a remote (a mirror, a second
  fork).
- **`defaultBranchOnly` is never set here, and the fetches never `--prune`.**
  A partial fork only saves clone size, and this clones nothing. It would
  leave `origin/*` refs for branches the fork lacks, and the next pruning
  fetch would delete refs that local branches track.

Four entry points raise `ForkCheckoutDialog`: the sidebar repo row's
read-only mark, the fork action on REMOTES' `origin` row, the worktree
header's `read-only` chip, and a forge-refused push. A mark that states the
constraint must also offer the way past it.

- The sidebar's `Fork…` button is the OTHER operation (`repo:fork`: search,
  fork, clone elsewhere), seeded from the selected row by `forkSeedFromRepo`.
- The marks do not ask the forge if a fork exists (a round trip per row).
  After its preflight, `forkCheckoutAction` says "Switch origin to my fork"
  instead of "Fork & switch origin".
- `pushWasDenied` (git-service.ts) classifies the one push failure with a
  remedy in PwrGit. It excludes a protected branch, which reads almost the
  same on GitLab but means the opposite about access.
