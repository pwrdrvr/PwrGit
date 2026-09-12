import { FORGE_KINDS, forgeProduct, type ForgeKind } from "@pwrgit/shared";
import { GitHubRepoProvider } from "./github/repo-provider";
import { GitLabRepoProvider } from "./gitlab/repo-provider";
import type { ForgeRepoProvider, ForgeRepoRegistry } from "./repo-provider";

/**
 * How each product builds the repository provider the clone and fork dialogs
 * reach through `ForgeRepoRegistry`.
 *
 * One factory per product, taking the hostname: the registry's default entry is
 * just that factory applied to the product's SaaS host, so there is no second
 * constructor expression to keep in sync with the first.
 *
 * The value is bound to its key (`ForgeRepoProvider & { host: K }`) because
 * `ForgeRepoRegistry.register` keys off `provider.host`, NOT off the key this
 * table is walked by. Without the binding, an entry whose builder returns the
 * wrong product type-checks, and `get("github", "ghe.acme.com")` then hands
 * back a provider that spawns the other product's CLI against a GitHub
 * Enterprise host.
 *
 * This was two hand-written `forges.register(...)` calls in `index.ts`, which
 * is the shape that loses a product in silence: an unregistered forge makes
 * `ForgeRepoRegistry.get()` answer null, and callers report that as
 * `unsupported_host` — so clone and fork would say the host is not supported on
 * a machine whose CLI is installed and signed in, with nothing naming the
 * omission. As a record, `tsc` asks for the entry.
 */
const REPO_PROVIDERS: Readonly<{
  [K in ForgeKind]: (hostname: string) => ForgeRepoProvider & { host: K };
}> = {
  github: (hostname) => new GitHubRepoProvider(undefined, hostname),
  gitlab: (hostname) => new GitLabRepoProvider(undefined, hostname)
};

/** Register every product's real repository provider. Not called under the E2E
 *  forge fixture, which supplies its own registry. */
export function registerRepoProviders(registry: ForgeRepoRegistry): void {
  for (const kind of FORGE_KINDS) {
    const build = REPO_PROVIDERS[kind];
    // The SaaS instance comes from the registry, not from each provider
    // module's private default, so the hostname `register` seeds `byHost`
    // under is the same one `ForgeHosts` probes and resolves.
    registry.register(build(forgeProduct(kind).saasHost), build);
  }
}
