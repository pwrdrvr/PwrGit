# forge — AGENTS.md

This module decides which forge a repo's `origin` points at, and asks it for
change-request status. `PrService` and `OpenPrService` (`../github/`) speak
`PrSummary` and never learn which forge answered. Per-forge detail:
`gitlab/AGENTS.md`, `gitcafe/AGENTS.md`.

**Always apply:**

- **Return an entry for every key requested.** `null` is a negative cache; an
  omitted key is a failure.
- **A refusal is not an answer.** Throw when a response resolved nothing.
- **Never negative-cache a failure.** Record the attempt instead.
- **A hostname is never evidence** of which product runs at a host.
- **A forge kind is not a host.** Pass the hostname too.
- **Never write `=== "github"` / `=== "gitlab"`.** Use a `Record<ForgeKind, …>`.
- **Only main talks to a forge.**

## Provider seam and failures

Read [the provider seam
guide](../../../../../docs/guides/main-forge/provider-seam-and-failures.md)
before changing a `ForgeProvider`, a forge client, `cli-runner.ts`,
`retry.ts`, `chunked.ts` or `PrService`'s failure marks.

- **The provider seam:** add a forge by implementing `ForgeProvider`; do not
  change either service. `fetchOpenPrs` is a complete walk or a throw.
- **Shared helpers:** `cli-runner.ts` spawns `gh`/`glab`; `retry.ts` holds the
  one retry decision. Change behavior there, not in a copy.
- **Failures:** a failed batch keeps the batches before it. Remember a failed
  attempt by scope, never as a cached "no change request".
- **GitLab specifics:** batching is native, `iid` is a String, `locked` maps
  to `open`.
- **Test fixture:** use `pwrdrvr/qa/forge/PwrGit-Test`, not the imported
  mirror.

## Forge hosts and status

Read [the hosts and status
guide](../../../../../docs/guides/main-forge/forge-hosts-and-status.md)
before changing host enumeration, `ForgeHosts`, `forge:hosts`,
`forge:status`, `status.ts` or Settings → Forges.

- **Forge hosts** are enumerated from each CLI, not guessed. A git remote is
  never a source.
- **Resolution and permission are different questions.** Ask both.
- **Canonicalize with `canonicalForgeHostname`**, everywhere.
- **Every surface gives one answer per host.** A new one goes in
  `forge-surfaces.property.test.ts`.
- **Status, capabilities, and who may call a forge:** `forge:status`
  summarizes per-host state. A disabled host is never probed. Clone and fork
  ask `forgeBlockAt(status, hostname)`.

## Adding a forge

Read [the adding-a-forge
guide](../../../../../docs/guides/main-forge/adding-a-forge.md)
before adding a forge kind or any per-product value.

- **Adding a forge:** add the member to `FORGE_KINDS` and fill in the seven
  sites `tsc` names. Add it to `packages/mcp-server` by hand.
- **Why they are all records:** a `Record<ForgeKind, …>` fails loudly; a
  ternary fails silently. `pnpm lint:forge-kinds` enforces it.

## Hover card, commit-author identity, SSH keys

Read [the identity
guide](../../../../../docs/guides/main-forge/commit-author-identity.md)
before changing `PrStatusCard`, `PrSummary`, `commit-author*.ts`,
`avatar-source.ts` or `ssh-host-keys.ts`.

- **The hover card** sends no request. Every `PrSummary` field after
  `isDraft` stays optional.
- **Commit-author identity:** transports are credential-opaque. Cache keys
  are per forge instance. `avatar-source.ts` is the URL allowlist.
- **Published SSH server keys:** never substitute `ssh-keyscan`, and never
  apply SaaS keys to another host.

## Repository metadata: a second seam, deliberately separate

Read [the repository metadata
guide](../../../../../docs/guides/main-forge/repository-metadata.md)
before changing `ForgeRepoProvider`, clone, fork, `repo_identity`, the gh
default repository, forge marks or the per-host switch's background readers.

- Clone, fork and identity marks use `ForgeRepoProvider`; do not widen
  `ForgeProvider`.
- **Identity is read from `origin`.** No row, `unknown` and `public` are three
  states.
- **The per-host switch gates the three background readers.** Switching off
  keeps what was asked.
- **A dialog opens on local state;** ask a forge only on debounced input.
