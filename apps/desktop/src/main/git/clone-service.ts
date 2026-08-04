import { existsSync, realpathSync, statSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import {
  err,
  ok,
  type CloneCatalog,
  type CloneDestination,
  type CloneProtocol,
  type CloneRepository,
  type Profile,
  type Repo,
  type Result
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import type { ProfileService } from "../profiles/profile-service";
import { mapLimit } from "../util/map-limit";
import { runGh } from "../github/gh-cli";
import { getGhStatus, type GhStatus } from "../github/pr-client";
import { parseGitHubRemote } from "../github/remote";
import { requireExit0, type GitExec } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";

const OWNER_CONCURRENCY = 3;
const REMOTE_CONCURRENCY = 8;
const OWNER_REPO_LIMIT = 200;
const OWNER_CACHE_TTL_MS = 5 * 60_000;
const EXACT_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type GhRunner = (
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<string>;
type GhStatusReader = () => Promise<GhStatus>;

type GitHubRepoJson = {
  name: string;
  nameWithOwner: string;
  description?: string | null;
  isPrivate: boolean;
  sshUrl: string;
  url: string;
  updatedAt?: string;
};

type LocalGitHubState = {
  owners: string[];
  pathsByRepo: Map<string, string[]>;
};

type RootIdentity = { display: string; canonical: string };

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function rootsFor(profile: Profile): RootIdentity[] {
  return profile.roots.map((root) => ({
    display: root,
    canonical: canonicalExistingPath(root)
  }));
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function containingRoot(
  roots: RootIdentity[],
  path: string
): RootIdentity | undefined {
  const canonical = canonicalExistingPath(path);
  return roots
    .filter((root) => isWithin(root.canonical, canonical))
    .sort((a, b) => b.canonical.length - a.canonical.length)[0];
}

export function normalizeGitHubRepository(input: string): string | null {
  const trimmed = input.trim().replace(/\.git$/i, "");
  return EXACT_REPOSITORY.test(trimmed) ? trimmed : null;
}

function inferredRecency(path: string): number {
  try {
    const stat = statSync(path);
    return Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs);
  } catch {
    return 0;
  }
}

/** Registered roots plus every ancestor prefix between a root and a repo. */
export function cloneDestinations(
  db: DB,
  profile: Profile,
  repos: Repo[]
): CloneDestination[] {
  const roots = rootsFor(profile);
  const repoPaths = repos.map((repo) => canonicalExistingPath(repo.path));
  const candidates = new Map<string, { root: RootIdentity; recency: number }>();

  for (const root of roots) {
    candidates.set(root.canonical, {
      root,
      recency: inferredRecency(root.canonical)
    });
  }

  for (const repoPath of repoPaths) {
    const root = containingRoot(roots, repoPath);
    if (root === undefined) continue;
    const recency = inferredRecency(repoPath);
    let prefix = dirname(repoPath);
    while (isWithin(root.canonical, prefix)) {
      const previous = candidates.get(prefix);
      candidates.set(prefix, {
        root,
        recency: Math.max(previous?.recency ?? 0, recency)
      });
      if (prefix === root.canonical) break;
      const parent = dirname(prefix);
      if (parent === prefix) break;
      prefix = parent;
    }
  }

  const recentRows = db
    .prepare(
      `SELECT path, last_used_at FROM clone_destinations
       WHERE profile_id = ? ORDER BY last_used_at DESC`
    )
    .all(profile.id) as { path: string; last_used_at: string }[];
  const lastUsedByPath = new Map<string, string>();
  for (const row of recentRows) {
    const path = canonicalExistingPath(row.path);
    const root = containingRoot(roots, path);
    if (root === undefined || !existsSync(path)) continue;
    lastUsedByPath.set(path, row.last_used_at);
    const previous = candidates.get(path);
    candidates.set(path, {
      root,
      recency: previous?.recency ?? inferredRecency(path)
    });
  }

  return [...candidates.entries()]
    .map(([path, candidate]): CloneDestination => {
      const relativePath = relative(candidate.root.canonical, path);
      const destination: CloneDestination = {
        path,
        root: candidate.root.display,
        relativePath,
        repoCount: repoPaths.filter((repoPath) => isWithin(path, repoPath)).length
      };
      const lastUsedAt = lastUsedByPath.get(path);
      if (lastUsedAt !== undefined) destination.lastUsedAt = lastUsedAt;
      return destination;
    })
    .sort((a, b) => {
      const aUsed = a.lastUsedAt ?? "";
      const bUsed = b.lastUsedAt ?? "";
      if (aUsed !== bUsed) return bUsed.localeCompare(aUsed);
      const aRoot = a.relativePath === "";
      const bRoot = b.relativePath === "";
      if (aRoot !== bRoot) return aRoot ? -1 : 1;
      const recency =
        (candidates.get(b.path)?.recency ?? 0) -
        (candidates.get(a.path)?.recency ?? 0);
      if (recency !== 0) return recency;
      if (a.repoCount !== b.repoCount) return b.repoCount - a.repoCount;
      return a.path.localeCompare(b.path);
    });
}

function repositoryFromJson(raw: unknown): CloneRepository | null {
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as GitHubRepoJson;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.nameWithOwner !== "string" ||
    typeof candidate.isPrivate !== "boolean" ||
    typeof candidate.sshUrl !== "string" ||
    typeof candidate.url !== "string"
  ) {
    return null;
  }
  const normalized = normalizeGitHubRepository(candidate.nameWithOwner);
  if (normalized === null) return null;
  const slash = normalized.indexOf("/");
  const repository: CloneRepository = {
    name: candidate.name,
    owner: normalized.slice(0, slash),
    nameWithOwner: normalized,
    isPrivate: candidate.isPrivate,
    sshUrl: candidate.sshUrl,
    httpsUrl: candidate.url,
    localPaths: []
  };
  if (
    typeof candidate.description === "string" &&
    candidate.description.trim() !== ""
  ) {
    repository.description = candidate.description;
  }
  if (typeof candidate.updatedAt === "string") {
    repository.updatedAt = candidate.updatedAt;
  }
  return repository;
}

export function parseCloneRepositories(stdout: string): CloneRepository[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => repositoryFromJson(row))
    .filter((row): row is CloneRepository => row !== null);
}

function messageFromUnknown(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const stderr = (cause as Error & { stderr?: string }).stderr?.trim();
  return (stderr || cause.message).split("\n")[0] ?? cause.message;
}

export class CloneService {
  private readonly ownerCache = new Map<
    string,
    { fetchedAt: number; repositories: CloneRepository[] }
  >();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    private readonly indexer: RepoIndexer,
    private readonly profiles: ProfileService,
    private readonly gh: GhRunner = runGh,
    private readonly readGhStatus: GhStatusReader = getGhStatus
  ) {}

  async catalog(profileId: string): Promise<Result<CloneCatalog>> {
    const profile = this.profiles.get(profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    const repos = this.indexer.listRepos(profileId);
    const [github, local] = await Promise.all([
      this.readGhStatus(),
      this.localGitHubState(repos)
    ]);
    const owners = [
      ...(profile.org?.trim() ? [profile.org.trim()] : []),
      ...local.owners
    ].filter(
      (owner, index, all) =>
        all.findIndex(
          (candidate) => candidate.toLowerCase() === owner.toLowerCase()
        ) === index
    );
    const base: CloneCatalog = {
      owners,
      repositories: [],
      destinations: cloneDestinations(this.db, profile, repos),
      github
    };
    if (!github.installed || !github.loggedIn || owners.length === 0) {
      return ok(base);
    }

    const failures: string[] = [];
    const repositoriesByOwner = new Map<string, CloneRepository[]>();
    await mapLimit(owners, OWNER_CONCURRENCY, async (owner) => {
      try {
        repositoriesByOwner.set(owner, await this.repositoriesForOwner(owner));
      } catch {
        failures.push(owner);
        repositoriesByOwner.set(owner, []);
      }
    });
    const repositories = owners
      .flatMap((owner) => repositoriesByOwner.get(owner) ?? [])
      .filter(
        (repository, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.nameWithOwner.toLowerCase() ===
              repository.nameWithOwner.toLowerCase()
          ) === index
      )
      .map((repository) => ({
        ...repository,
        localPaths:
          local.pathsByRepo.get(repository.nameWithOwner.toLowerCase()) ?? []
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

    const catalog: CloneCatalog = { ...base, repositories };
    if (failures.length > 0) {
      catalog.warning = `Couldn't load repositories for ${failures.join(", ")}.`;
    }
    return ok(catalog);
  }

  async checkSource(
    profileId: string,
    input: string
  ): Promise<Result<CloneRepository>> {
    if (this.profiles.get(profileId) === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    const nameWithOwner = normalizeGitHubRepository(input);
    if (nameWithOwner === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: "Enter a GitHub repository as owner/name."
      });
    }
    const status = await this.readGhStatus();
    if (!status.installed) {
      return err({
        kind: "remote",
        code: "github_cli_missing",
        message: "Install GitHub CLI to look up repositories."
      });
    }
    if (!status.loggedIn) {
      return err({
        kind: "remote",
        code: "github_login_required",
        message: "Sign in with GitHub CLI to look up repositories."
      });
    }
    try {
      const stdout = await this.gh([
        "repo",
        "view",
        nameWithOwner,
        "--json",
        "name,nameWithOwner,description,isPrivate,sshUrl,url,updatedAt"
      ]);
      const repository = parseCloneRepositories(stdout)[0];
      if (repository === undefined) {
        throw new Error("GitHub returned no repository");
      }
      const local = await this.localGitHubState(this.indexer.listRepos(profileId));
      repository.localPaths =
        local.pathsByRepo.get(repository.nameWithOwner.toLowerCase()) ?? [];
      return ok(repository);
    } catch (cause) {
      return err({
        kind: "remote",
        code: "repository_not_found",
        message: `Couldn't find ${nameWithOwner} on GitHub. ${messageFromUnknown(cause)}`
      });
    }
  }

  async clone(input: {
    profileId: string;
    nameWithOwner: string;
    protocol: CloneProtocol;
    parentPath: string;
  }): Promise<Result<Repo>> {
    const profile = this.profiles.get(input.profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${input.profileId}"`
      });
    }
    const nameWithOwner = normalizeGitHubRepository(input.nameWithOwner);
    if (nameWithOwner === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: "Enter a GitHub repository as owner/name."
      });
    }
    if (!(["ssh", "https", "gh_cli"] as const).includes(input.protocol)) {
      return err({
        kind: "validation",
        code: "invalid_clone_protocol",
        message: "Choose SSH, HTTPS, or GitHub CLI."
      });
    }

    const parentPath = canonicalExistingPath(input.parentPath);
    if (containingRoot(rootsFor(profile), parentPath) === undefined) {
      return err({
        kind: "validation",
        code: "destination_outside_roots",
        message: "Choose a checkout folder inside one of this profile's repo folders."
      });
    }
    let parentIsDirectory = false;
    try {
      parentIsDirectory = statSync(parentPath).isDirectory();
    } catch {
      // The validation error below is clearer than a raw fs exception.
    }
    if (!parentIsDirectory) {
      return err({
        kind: "validation",
        code: "destination_missing",
        message: `Checkout folder does not exist: ${parentPath}`
      });
    }

    const repoName = nameWithOwner.slice(nameWithOwner.indexOf("/") + 1);
    const destination = join(parentPath, repoName);
    if (existsSync(destination)) {
      return err({
        kind: "validation",
        code: "destination_exists",
        message: `A file or folder already exists at ${destination}`
      });
    }

    if (input.protocol === "gh_cli") {
      try {
        await this.gh(["repo", "clone", nameWithOwner, destination], {
          timeoutMs: 10 * 60_000
        });
      } catch (cause) {
        return err({
          kind: "git",
          code: "clone_failed",
          message: messageFromUnknown(cause)
        });
      }
    } else {
      const remote =
        input.protocol === "ssh"
          ? `git@github.com:${nameWithOwner}.git`
          : `https://github.com/${nameWithOwner}.git`;
      const cloned = await this.git(["clone", "--", remote, destination], parentPath);
      if (!cloned.ok) return cloned;
      const checked = requireExit0(cloned.value, ["clone"]);
      if (!checked.ok) return checked;
    }

    const indexed = await this.indexer.indexRepoAt(input.profileId, destination);
    if (!indexed.ok) {
      return err({
        kind: "repo",
        code: "clone_index_failed",
        message: `Cloned to ${destination}, but couldn't add it to PwrGit: ${indexed.error.message}`
      });
    }
    this.db
      .prepare(
        `INSERT INTO clone_destinations (profile_id, path, last_used_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(profile_id, path) DO UPDATE SET last_used_at = datetime('now')`
      )
      .run(input.profileId, parentPath);
    return indexed;
  }

  private async repositoriesForOwner(owner: string): Promise<CloneRepository[]> {
    const cached = this.ownerCache.get(owner.toLowerCase());
    if (
      cached !== undefined &&
      Date.now() - cached.fetchedAt < OWNER_CACHE_TTL_MS
    ) {
      return cached.repositories;
    }
    const stdout = await this.gh([
      "repo",
      "list",
      owner,
      "--limit",
      String(OWNER_REPO_LIMIT),
      "--json",
      "name,nameWithOwner,description,isPrivate,sshUrl,url,updatedAt"
    ]);
    const repositories = parseCloneRepositories(stdout);
    this.ownerCache.set(owner.toLowerCase(), {
      fetchedAt: Date.now(),
      repositories
    });
    return repositories;
  }

  private async localGitHubState(repos: Repo[]): Promise<LocalGitHubState> {
    const pathsByRepo = new Map<string, string[]>();
    const owners: string[] = [];
    await mapLimit(repos, REMOTE_CONCURRENCY, async (repo) => {
      const result = await this.git(["remote", "-v"], repo.path);
      if (!result.ok || result.value.exitCode !== 0) return;
      const seen = new Set<string>();
      for (const line of result.value.stdout.split("\n")) {
        const url = /^\S+\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line)?.[1];
        if (url === undefined) continue;
        const parsed = parseGitHubRemote(url);
        if (parsed === null) continue;
        const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (
          !owners.some(
            (owner) => owner.toLowerCase() === parsed.owner.toLowerCase()
          )
        ) {
          owners.push(parsed.owner);
        }
        const paths = pathsByRepo.get(key) ?? [];
        if (!paths.includes(repo.path)) paths.push(repo.path);
        pathsByRepo.set(key, paths);
      }
    });
    return { owners, pathsByRepo };
  }
}
