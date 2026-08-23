import {
  isSafeProjectPath,
  parseForgeRemote,
  type CloneDestination,
  type CloneRepository,
  type ForgeHost
} from "@pwrgit/shared";

/** `gh repo clone X` / `glab repo clone X` pasted straight from a terminal.
 *  The CLI in the command names the forge, which is worth honouring — it is
 *  more specific than the dialog's current host. */
const CLI_CLONE = /^(gh|glab)\s+repo\s+clone\s+(\S+)$/i;

/** Path forms whose meaning does not depend on the app process's cwd. Actual
 * existence and Git validity are checked in main, where filesystem access
 * belongs. */
export function localRepositoryPath(input: string): string | null {
  const trimmed = input.trim();
  if (
    /^~(?:$|[\\/])/.test(trimmed) ||
    /^[\\/]/.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return trimmed;
  }
  return null;
}

export function defaultHostname(host: ForgeHost): string {
  return host === "gitlab" ? "gitlab.com" : "github.com";
}

/**
 * Order search results for display. Ranks, never filters.
 *
 * The forge did the matching — it can hit a description or a topic this
 * scoring knows nothing about — so a row that survived the search always
 * survives this. All this decides is what lands under the cursor: an exact
 * slug first, then a name that starts with what was typed.
 */
export function rankCloneRepositories(
  repositories: CloneRepository[],
  query: string,
  limit = 80
): CloneRepository[] {
  const exact = query.trim().toLowerCase();
  return repositories
    .map((repository) => {
      const name = repository.name.toLowerCase();
      const full = repository.nameWithOwner.toLowerCase();
      const score =
        (full === exact ? 100 : 0) +
        (name === exact ? 60 : 0) +
        (name.startsWith(exact) ? 40 : 0) +
        (full.startsWith(exact) ? 20 : 0) +
        (name.includes(exact) ? 10 : 0);
      return { repository, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.repository.updatedAt ?? "").localeCompare(
          a.repository.updatedAt ?? ""
        ) ||
        a.repository.nameWithOwner.localeCompare(b.repository.nameWithOwner)
    )
    .slice(0, limit)
    .map((entry) => entry.repository);
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

export function cloneDestinationLabel(destination: CloneDestination): string {
  const rootName = pathSegments(destination.root).at(-1) ?? destination.root;
  const relative = destination.relativePath.replaceAll("\\", "/");
  return relative === "" ? `${rootName}/` : `${rootName}/${relative}/`;
}

export function filterCloneDestinations(
  destinations: CloneDestination[],
  query: string
): CloneDestination[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter(Boolean);
  return destinations.filter((destination) => {
    const text = `${cloneDestinationLabel(destination)} ${destination.path}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function cloneDestinationSelectionIndex(
  destinations: CloneDestination[],
  selectedPath: string | null
): number {
  if (selectedPath === null) return 0;
  const index = destinations.findIndex(
    (destination) => destination.path === selectedPath
  );
  return index === -1 ? 0 : index;
}

/** An input that names one exact repository, and the forge it names it on. */
export type ExactRepository = {
  host: ForgeHost;
  hostname: string;
  nameWithOwner: string;
};

/**
 * Resolve an exact repository from what the user typed or pasted.
 *
 * A full remote URL names its own forge and wins. A bare `owner/name` cannot
 * — the same slug exists on both — so it falls back to `defaultHost`, which
 * is the host toggle's current value.
 */
export function exactRepository(
  input: string,
  defaultHost: ForgeHost = "github"
): ExactRepository | null {
  const trimmed = input.trim();
  if (localRepositoryPath(trimmed) !== null) return null;
  const cliClone = CLI_CLONE.exec(trimmed);
  const candidate = cliClone?.[2] ?? trimmed;
  const cliHost: ForgeHost | null =
    cliClone?.[1]?.toLowerCase() === "glab"
      ? "gitlab"
      : cliClone !== null
        ? "github"
        : null;

  // A URL is only parsed as one when it actually carries a scheme or an
  // scp-style `user@host:` prefix. `parseForgeRemote` would otherwise read a
  // bare `owner/name` as an scp remote whose host is the owner.
  const isUrl =
    /^(?:https?|ssh|git):\/\//i.test(candidate) ||
    /^[^\s/]+@[^\s:/]+:/.test(candidate);
  if (isUrl) {
    const remote = parseForgeRemote(candidate);
    if (remote === null || !isSafeProjectPath(remote.nameWithOwner)) return null;
    return {
      host: remote.host,
      hostname: remote.hostname,
      nameWithOwner: remote.nameWithOwner
    };
  }

  const nameWithOwner = candidate.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!isSafeProjectPath(nameWithOwner)) return null;
  const host = cliHost ?? defaultHost;
  return { host, hostname: defaultHostname(host), nameWithOwner };
}

/** A stand-in for a repository the forge would not confirm — no CLI, or not
 *  signed in. Its visibility is `unknown`, not `public`: the whole point of
 *  the third state is that we must not guess this one. */
export function unverifiedCloneRepository(
  input: string,
  defaultHost: ForgeHost = "github"
): CloneRepository | null {
  const exact = exactRepository(input, defaultHost);
  if (exact === null) return null;
  const slash = exact.nameWithOwner.lastIndexOf("/");
  return {
    name: exact.nameWithOwner.slice(slash + 1),
    owner: exact.nameWithOwner.slice(0, slash),
    nameWithOwner: exact.nameWithOwner,
    description: "Not verified — clone with SSH or HTTPS",
    visibility: "unknown",
    host: exact.host,
    hostname: exact.hostname,
    sshUrl: `git@${exact.hostname}:${exact.nameWithOwner}.git`,
    httpsUrl: `https://${exact.hostname}/${exact.nameWithOwner}.git`,
    localPaths: []
  };
}

export function moveCloneSelection(
  current: number,
  direction: -1 | 1,
  resultCount: number
): number {
  if (resultCount === 0) return 0;
  return Math.min(Math.max(current + direction, 0), resultCount - 1);
}

export function cloneRepositoryAtSelection(
  repositories: CloneRepository[],
  selection: number
): CloneRepository | undefined {
  return repositories[selection] ?? repositories[0];
}
