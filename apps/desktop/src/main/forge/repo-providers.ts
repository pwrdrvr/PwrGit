import { FORGE_KINDS, type ForgeKind } from "@pwrgit/shared";
import { GitHubRepoProvider } from "./github/repo-provider";
import { GitLabRepoProvider } from "./gitlab/repo-provider";
import type { ForgeRepoProvider, ForgeRepoRegistry } from "./repo-provider";

/**
 * How one product builds the repository provider the clone and fork dialogs
 * reach through `ForgeRepoRegistry`.
 *
 * The factory is what lets the registry reach an Enterprise or self-managed
 * instance: one provider per hostname, built on demand and cached.
 */
type RepoProviderBuilder = {
  /** The default instance — the product's SaaS host. */
  saas: () => ForgeRepoProvider;
  /** Any other hostname. */
  atHost: (hostname: string) => ForgeRepoProvider;
};

/**
 * Every product's repository provider, in one table.
 *
 * This was two hand-written `forges.register(...)` calls in `index.ts`, which
 * is the shape that loses a product in silence: an unregistered forge makes
 * `ForgeRepoRegistry.get()` answer null, and callers report that as
 * `unsupported_host` — so clone and fork would say the host is not supported on
 * a machine whose CLI is installed and signed in, with nothing naming the
 * omission. As a record, `tsc` asks for the entry.
 */
const REPO_PROVIDERS: Readonly<Record<ForgeKind, RepoProviderBuilder>> = {
  github: {
    saas: () => new GitHubRepoProvider(),
    atHost: (hostname) => new GitHubRepoProvider(undefined, hostname)
  },
  gitlab: {
    saas: () => new GitLabRepoProvider(),
    atHost: (hostname) => new GitLabRepoProvider(undefined, hostname)
  }
};

/** Register every product's real repository provider. Not called under the E2E
 *  forge fixture, which supplies its own registry. */
export function registerRepoProviders(registry: ForgeRepoRegistry): void {
  for (const kind of FORGE_KINDS) {
    const build = REPO_PROVIDERS[kind];
    registry.register(build.saas(), build.atHost);
  }
}
