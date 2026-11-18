# Adding a forge kind

This guide covers the seven registry sites a new forge kind fills in, and why every per-product value lives in a `Record<ForgeKind, …>`.

Code paths in backticks are relative to [apps/desktop/src/main/forge](../../../apps/desktop/src/main/forge/).

## Adding a forge

**A provider class per seam, plus one registry entry.** Add the member to
`FORGE_KINDS` (`packages/shared/src/types.ts`) and run `pnpm typecheck`. Each
site to fill in is a missing-property error that names its file. There are
seven:

- `FORGE_PRODUCTS` (`packages/shared/src/forge-product.ts`). **Data only**;
  the renderer reads it too. Name, CLI, SaaS host, change-request noun and
  sigil, non-personal account word, project path depth, env host allowlist,
  "add a host" wording, async forking, and `capabilities`.
- `PROVIDERS` (`providers.ts`): the `ForgeProvider` seam.
- `REPO_PROVIDERS` (`repo-providers.ts`): the `ForgeRepoProvider` seam that
  clone and fork reach through `ForgeRepoRegistry`.
- The commit-author transports (`commit-author-transport.ts`).
- `HOST_ENUMERATORS` (`cli-hosts.ts`): how the CLI reports signed-in hosts.
- `DEFAULT_PROBES` (`status.ts`): installed, and signed in at a host.
- `RATE_LIMIT_DIALECT` (`retry.ts`): rate-limit header spelling.

To verify, add a throwaway kind, confirm `tsc` names exactly those seven, and
remove it.

`REPO_PROVIDERS`, `DEFAULT_PROBES` and `FORGE_PRODUCTS` (no `kind` field) bind
the key to the value's kind. `ForgeRepoRegistry` keys off `provider.host`, not
the table key. So a value that disagrees with its key sends one product's hosts
to another product's CLI.

**`packages/mcp-server` is the one place neither `tsc` nor the lint helps.** It
bundles standalone and imports nothing from `@pwrgit/shared`. It keeps its own
`"github" | "gitlab" | "gitcafe"` union, `classifyProvider`, a copy of
`canonicalForgeHostname`, and literal `PWRGIT_*_HOSTS` names. Its order is
`kindFor`'s: env allowlists in `FORGE_KINDS` order, then SaaS hostnames. Add a
new product there by hand, or its checkouts report as `other`.
`forge-surfaces.property.test.ts` holds it to `kindFor` with no settings and no
enumeration, so a missed product fails there.

### Why they are all records

- **`Record<ForgeKind, …>` fails loudly.** A new kind is a missing-property
  error, so `tsc` lists what to fill in.
- **A ternary fails silently.** `kind === "gitlab" ? glab : gh` sends a new
  forge to GitHub, and no compiler or two-kind test catches it.
- **A hand-written pair of calls fails the same way.** Two literal
  `forges.register(...)` calls reported a third product's clone and fork as
  `unsupported_host` while its CLI was signed in.

**`pnpm lint:forge-kinds` is the regression test.** It runs second in
`pnpm lint` (after `lint:syntax`), so CI's Typecheck job runs it. It fails on
any hand-written kind comparison (`x === "github"`, `x !== "gitlab"`,
`case "gitlab":`) in non-test source under `packages/shared/src` or
`apps/desktop/src`. It reads the kinds from `FORGE_KINDS`. There were 29
violations in 18 files before the registry. Never fix a violation with an
exception in the script.

When you add anything per-product:

- **Never write a new `=== "github"` / `=== "gitlab"` comparison.** Put the
  value in `FORGE_PRODUCTS` (data) or behind a provider method (behaviour).
  Guards: `isForgeKind`, `toForgeHost` (shared). Accessors: `forgeProductFor`,
  `forgeProductOrAssumed`.
- **`FORGE_KINDS` is the member list.** `Object.keys(table) as ForgeKind[]`
  asserts completeness instead of proving it.
- **Put data in `packages/shared`**, even if only main reads it today.
  `renderer-does-not-import-main` blocks main's tables, and renderer-local
  copies drift: `FORGE_CLI` got two spellings, and `KIND_LABEL` and
  `FORGE_LABELS` were the same map in one directory.
- **`ASSUMED_FORGE_KIND` is the one place `other` becomes GitHub** (formerly
  eight ternaries: a clone hint, a default hostname, an error sentence). The
  behavior is kept, not endorsed; the name makes it greppable.
