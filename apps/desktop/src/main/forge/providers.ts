import { githubProvider } from "./github/provider";
import { gitlabProvider } from "./gitlab/provider";
import { resolveForgeRepo, type ForgeHostOverrides } from "./resolve";
import type { ForgeKind, ForgeProvider, ForgeRepo } from "./types";

const PROVIDERS: Readonly<Record<ForgeKind, ForgeProvider>> = {
  github: githubProvider,
  gitlab: gitlabProvider
};

export function providerFor(kind: ForgeKind): ForgeProvider {
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
  return repo === null ? null : { provider: providerFor(repo.kind), repo };
}
