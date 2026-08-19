import type { PrSummary } from "@pwrgit/shared";
import {
  fetchPrsByNumbers,
  fetchPrsForCommits,
  fetchPrsForRepo,
  getGitHubToken
} from "../../github/pr-client";
import { githubOwnerAndName } from "../resolve";
import { stampForge, type ForgeProvider, type ForgeRepo } from "../types";

/**
 * GitHub as a `ForgeProvider`.
 *
 * A thin adapter over the existing batched GraphQL client: the only real work
 * is splitting `ForgeRepo.path` back into the owner/name pair that GitHub's
 * GraphQL arguments require. Behavior is unchanged from before the abstraction.
 */
export const githubProvider: ForgeProvider = {
  kind: "github",

  getToken: async () => getGitHubToken(),

  fetchPrsForBranches: async (token, repo, branches) => {
    const parts = githubOwnerAndName(repo);
    if (parts === null) return emptyFor(branches);
    return stampForge(
      await fetchPrsForRepo(token, parts.owner, parts.name, branches),
      repo
    );
  },

  fetchPrsForCommits: async (token, repo, commitHashes) => {
    const parts = githubOwnerAndName(repo);
    if (parts === null) return emptyFor(commitHashes);
    return stampForge(
      await fetchPrsForCommits(token, parts.owner, parts.name, commitHashes),
      repo
    );
  },

  fetchPrsByNumbers: async (token, repo: ForgeRepo, numbers) => {
    const parts = githubOwnerAndName(repo);
    if (parts === null) return new Map<number, PrSummary | null>();
    return stampForge(
      await fetchPrsByNumbers(token, parts.owner, parts.name, numbers),
      repo
    );
  }
};

/** A path that cannot be split is not a repo we can query — cache nothing. */
function emptyFor(keys: string[]): Map<string, PrSummary | null> {
  void keys;
  return new Map<string, PrSummary | null>();
}
