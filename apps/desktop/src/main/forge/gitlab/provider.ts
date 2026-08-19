import { getGitLabToken } from "./glab-cli";
import {
  fetchMrsByNumbers,
  fetchMrsForBranches,
  fetchMrsForCommits
} from "./mr-client";
import { stampForge, type ForgeProvider } from "../types";

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
  fetchPrsForBranches: async (token, repo, branches) =>
    stampForge(await fetchMrsForBranches(token, repo, branches), repo),
  fetchPrsForCommits: async (token, repo, commitHashes) =>
    stampForge(await fetchMrsForCommits(token, repo, commitHashes), repo),
  fetchPrsByNumbers: async (token, repo, numbers) =>
    stampForge(await fetchMrsByNumbers(token, repo, numbers), repo)
};
