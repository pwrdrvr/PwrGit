import type { PrSummary } from "@pwrgit/shared";
import {
  fetchOpenPrs,
  fetchPrsByNumbers,
  fetchPrsForCommits,
  fetchPrsForRepo,
  getGitHubToken
} from "../../github/pr-client";
import { ForgeResponseError } from "../repo-provider";
import { githubOwnerAndName } from "../resolve";
import {
  stampForge,
  stampOpenList,
  type TokenForgeProvider,
  type ForgeRepo
} from "../types";

/**
 * GitHub as a `ForgeProvider`.
 *
 * Splits `ForgeRepo.path` for GraphQL and limits source candidates to this
 * GitHub instance; a same-named repository on another host proves nothing.
 */
export const githubProvider: TokenForgeProvider = {
  kind: "github",

  getToken: async (host) => getGitHubToken(host),

  fetchPrsForBranches: async (token, repo, branches, sourceRepos = [repo]) => {
    const parts = githubOwnerAndName(repo);
    if (parts === null) return emptyFor(branches);
    return stampForge(
      await fetchPrsForRepo(token, repo, parts.owner, parts.name, branches,
        sourceRepos.filter((source) => source.kind === repo.kind &&
          source.host.toLowerCase() === repo.host.toLowerCase() && source.port === repo.port)
          .map((source) => source.path)),
      repo
    );
  },

  fetchPrsForCommits: async (token, repo, commitHashes) => {
    const parts = githubOwnerAndName(repo);
    if (parts === null) return emptyFor(commitHashes);
    return stampForge(
      await fetchPrsForCommits(
        token,
        repo,
        parts.owner,
        parts.name,
        commitHashes
      ),
      repo
    );
  },

  fetchPrsByNumbers: async (token, repo: ForgeRepo, numbers) => {
    const parts = githubOwnerAndName(repo);
    if (parts === null) return new Map<number, PrSummary | null>();
    return stampForge(
      await fetchPrsByNumbers(token, repo, parts.owner, parts.name, numbers),
      repo
    );
  },

  fetchOpenPrs: async (token, repo) => {
    const parts = githubOwnerAndName(repo);
    // Not a repository GitHub can be asked about; there is no list to replace
    // the cached one with, so this is a refusal rather than an empty answer.
    if (parts === null) {
      throw new ForgeResponseError("Not a GitHub owner/name repository path.");
    }
    return stampOpenList(
      await fetchOpenPrs(token, repo, parts.owner, parts.name),
      repo
    );
  }
};

/** A path that cannot be split is not a repo we can query — cache nothing. */
function emptyFor(keys: string[]): Map<string, PrSummary | null> {
  void keys;
  return new Map<string, PrSummary | null>();
}
