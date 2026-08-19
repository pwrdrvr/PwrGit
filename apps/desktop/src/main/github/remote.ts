import { parseForgeRemote } from "@pwrgit/shared";

export type GitHubRepo = { owner: string; repo: string };

/**
 * Parse a git remote URL into {owner, repo}, github.com only (null otherwise).
 *
 * Deliberately narrower than `parseForgeRemote`: every caller here talks to
 * api.github.com, so a GitHub Enterprise host must NOT resolve — that would
 * point PR queries at the wrong API. Host detection for the identity marks
 * uses `parseForgeRemote` directly.
 */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const parsed = parseForgeRemote(url);
  if (parsed === null || parsed.hostname !== "github.com") return null;
  // github.com projects are always exactly owner/repo — a deeper path is a
  // gist, a wiki, or a URL that only looks like a repository.
  if (parsed.owner.includes("/")) return null;
  return { owner: parsed.owner, repo: parsed.repo };
}
