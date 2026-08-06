import type { Commit } from "@pwrgit/shared";

const MAX_COMMIT_RESULTS = 30;

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function scoreCommit(commit: Commit, normalizedQuery: string): number | null {
  const hashQuery = normalizedQuery.replaceAll(" ", "");
  if (
    commit.hash.toLowerCase().startsWith(hashQuery) ||
    commit.shortHash.toLowerCase().startsWith(hashQuery)
  ) {
    return 0;
  }

  const subject = normalize(commit.subject);
  if (subject.startsWith(normalizedQuery)) return 1;
  if (subject.includes(normalizedQuery)) return 2;

  const terms = normalizedQuery.split(" ");
  if (terms.every((term) => subject.includes(term))) return 3;

  const author = normalize(`${commit.authorName} ${commit.authorEmail}`);
  if (terms.every((term) => author.includes(term))) return 4;
  return null;
}

/** Search the commits already loaded for the selected timeline. */
export function searchCommits(commits: Commit[], query: string): Commit[] {
  const normalizedQuery = normalize(query);
  if (normalizedQuery === "") return [];

  return commits
    .map((commit, index) => ({
      commit,
      index,
      score: scoreCommit(commit, normalizedQuery)
    }))
    .filter(
      (candidate): candidate is typeof candidate & { score: number } =>
        candidate.score !== null
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, MAX_COMMIT_RESULTS)
    .map(({ commit }) => commit);
}
