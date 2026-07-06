export type GitHubRepo = { owner: string; repo: string };

/**
 * Parse a git remote URL into {owner, repo}, github.com only (null otherwise).
 * Handles scp-style (git@github.com:o/r.git) and url-style (https/ssh/git://,
 * optional user@, optional .git, optional trailing slash).
 */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const trimmed = url.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scp?.[1] && scp[2]) return { owner: scp[1], repo: scp[2] };
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(
      trimmed
    );
  if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] };
  return null;
}
