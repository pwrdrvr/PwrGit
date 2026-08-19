import { getGitLabToken } from "./glab-cli";
import {
  fetchMrsByNumbers,
  fetchMrsForBranches,
  fetchMrsForCommits
} from "./mr-client";
import type { ForgeProvider } from "../types";

/**
 * GitLab as a `ForgeProvider`.
 *
 * Merge requests are PwrGit's "PRs": `iid` is the number the UI shows, and the
 * mapping onto `PrSummary` happens in `mr-query.ts` so the service above never
 * learns which forge it is talking to.
 */
export const gitlabProvider: ForgeProvider = {
  kind: "gitlab",
  getToken: async (host) => getGitLabToken(host),
  fetchPrsForBranches: (token, repo, branches) =>
    fetchMrsForBranches(token, repo, branches),
  fetchPrsForCommits: (token, repo, commitHashes) =>
    fetchMrsForCommits(token, repo, commitHashes),
  fetchPrsByNumbers: (token, repo, numbers) =>
    fetchMrsByNumbers(token, repo, numbers)
};
