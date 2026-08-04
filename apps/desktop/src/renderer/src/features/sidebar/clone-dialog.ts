import type { CloneDestination, CloneRepository } from "@pwrgit/shared";

const repoText = (repository: CloneRepository): string =>
  `${repository.nameWithOwner} ${repository.description ?? ""}`.toLowerCase();

export function filterCloneRepositories(
  repositories: CloneRepository[],
  query: string,
  limit = 80
): CloneRepository[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter(Boolean);
  const scored = repositories
    .map((repository) => {
      const text = repoText(repository);
      if (!terms.every((term) => text.includes(term))) return null;
      const name = repository.name.toLowerCase();
      const full = repository.nameWithOwner.toLowerCase();
      const exact = query.trim().toLowerCase();
      const score =
        (full === exact ? 100 : 0) +
        (name.startsWith(exact) ? 40 : 0) +
        (full.startsWith(exact) ? 20 : 0) +
        (name.includes(exact) ? 10 : 0);
      return { repository, score };
    })
    .filter(
      (entry): entry is { repository: CloneRepository; score: number } =>
        entry !== null
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.repository.updatedAt ?? "").localeCompare(
          a.repository.updatedAt ?? ""
        ) ||
        a.repository.nameWithOwner.localeCompare(b.repository.nameWithOwner)
    );
  return scored.slice(0, limit).map((entry) => entry.repository);
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

export function exactGitHubRepository(input: string): string | null {
  const normalized = input.trim().replace(/\.git$/i, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)
    ? normalized
    : null;
}
