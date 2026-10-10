import { gitcafeProvider } from "./gitcafe/provider";
import { githubProvider } from "./github/provider";
import { gitlabProvider } from "./gitlab/provider";
import { resolveForgeRepo, type ForgeHostOverrides } from "./resolve";
import type { ForgeKind, ForgeProvider, ForgeRepo } from "./types";

const PROVIDERS: Readonly<Record<ForgeKind, ForgeProvider | null>> = {
  artifacts: null,
  github: githubProvider,
  gitlab: gitlabProvider,
  gitcafe: gitcafeProvider
};

export function providerFor(kind: ForgeKind): ForgeProvider | null {
  return PROVIDERS[kind];
}

export type ResolvedForge = { provider: ForgeProvider; repo: ForgeRepo };

/**
 * Resolve a remote URL to the provider that can answer for it.
 *
 * Returns null for anything unrecognized, which is what keeps the whole
 * feature best-effort: an unknown host simply produces no PR status.
 */
export function resolveForge(
  remoteUrl: string,
  overrides: ForgeHostOverrides = {}
): ResolvedForge | null {
  const repo = resolveForgeRepo(remoteUrl, overrides);
  const provider = repo === null ? null : providerFor(repo.kind);
  return repo === null || provider === null ? null : { provider, repo };
}
