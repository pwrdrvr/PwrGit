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
  forgeCloneUrls,
  isSafeForgeHostname,
  isSafeProjectPath,
  ok,
  parseForgeRemote,
  type CloneCatalog,
  type CloneDestination,
  type CloneProgress,
  type CloneProtocol,
  type CloneRepository,
  type ForgeHost,
  type ForgeOwner,
  type ForgeStatus,
  type Profile,
  type Repo,
  type Result
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import type { ProfileService } from "../profiles/profile-service";
import { mapLimit } from "../util/map-limit";
import type { ForgeProvider, ForgeRegistry } from "../forge/provider";
import { requireExit0, type GitExec } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";

const OWNER_CONCURRENCY = 3;
const REMOTE_CONCURRENCY = 8;
const OWNER_REPO_LIMIT = 200;
const OWNER_CACHE_TTL_MS = 5 * 60_000;

/** An owner discovered from a local remote, or configured on the profile. */
type OwnerCandidate = ForgeOwner & {
  /** Owners that came only from `profile.org` are a guess — the org may not
   *  exist on that forge at all — so a failure to list them is not reported
   *  as a warning the way a locally-observed owner's would be. */
  probed: boolean;
};

type LocalForgeState = {
  owners: OwnerCandidate[];
  /** Keyed `host:nameWithOwner`, lowercased — two forges can host the same
   *  slug, and merging them would attach the wrong checkout to a repository. */
  pathsByRepo: Map<string, string[]>;
};

function repoKey(host: ForgeHost, nameWithOwner: string): string {
  return `${host}:${nameWithOwner}`.toLowerCase();
}

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

/** Accept a project path for either forge. GitLab nests subgroups, so this is
 *  no longer "exactly two segments" — `isSafeProjectPath` bounds the depth and
 *  the characters instead. */
export function normalizeRepositoryPath(input: string): string | null {
  const trimmed = input.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return isSafeProjectPath(trimmed) ? trimmed : null;
}

function inferredRecency(path: string): number {
  try {
    const stat = statSync(path);
    return Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs);
  } catch {
    return 0;
  }
}

/** Validate a checkout folder and the repository folder that would be made
 *  inside it. Shared by clone and fork so the two cannot disagree about what
 *  counts as a legal destination — the roots check is a real boundary, not a
 *  nicety. */
export function validateCheckoutDestination(
  profile: Profile,
  parentPathInput: string,
  repoName: string
): Result<{ parentPath: string; destination: string }> {
  const parentPath = canonicalExistingPath(parentPathInput);
  if (containingRoot(rootsFor(profile), parentPath) === undefined) {
    return err({
      kind: "validation",
      code: "destination_outside_roots",
      message:
        "Choose a checkout folder inside one of this profile's repo folders."
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
  const destination = join(parentPath, repoName);
  if (existsSync(destination)) {
    return err({
      kind: "validation",
      code: "destination_exists",
      message: `A file or folder already exists at ${destination}`
    });
  }
  return ok({ parentPath, destination });
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

function messageFromUnknown(provider: ForgeProvider, cause: unknown): string {
  const message = provider.errorMessage(cause);
  return message.split("\n")[0] ?? message;
}

const CLONE_PHASES: Record<string, CloneProgress["phase"]> = {
  "Counting objects": "counting",
  "Compressing objects": "compressing",
  "Receiving objects": "receiving",
  "Resolving deltas": "resolving",
  "Updating files": "checking_out",
  "Filtering content": "checking_out"
};
const CLONE_ENV = { LC_ALL: "C", LANG: "C" } as const;

/** Parse one carriage-return-delimited progress update written by Git. */
export function parseCloneProgressLine(line: string): CloneProgress | null {
  const normalized = line
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .replace(/^remote:\s*/, "");
  const match = /^(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Filtering content):\s+(\d+)%\s+\((\d+)\/(\d+)\)(.*)$/.exec(
    normalized
  );
  if (match === null) return null;

  const progress: CloneProgress = {
    phase: CLONE_PHASES[match[1]!]!,
    percent: Number(match[2]),
    completedObjects: Number(match[3]),
    totalObjects: Number(match[4])
  };
  if (progress.phase === "receiving") {
    const suffix = match[5] ?? "";
    const bytes = /,\s*([\d.]+\s+(?:bytes?|[KMGTPE]i?B))/i.exec(suffix)?.[1];
    const rate = /\|\s*([^,]+?\/s)(?:,|$)/i.exec(suffix)?.[1];
    if (bytes !== undefined) progress.bytesReceived = bytes;
    if (rate !== undefined) progress.transferRate = rate.trim();
  }
  return progress;
}

/** Reassemble chunked stderr into the updates Git separates with CR/LF. */
export function createCloneProgressParser(
  onProgress: (progress: CloneProgress) => void
): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    const lines = `${pending}${chunk}`.split(/[\r\n]/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const progress = parseCloneProgressLine(line);
      if (progress !== null) onProgress(progress);
    }
  };
}

/** Remove high-volume progress meters while preserving actionable failures. */
export function sanitizeCloneStderr(stderr: string): string {
  return stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (line === "") return false;
      if (parseCloneProgressLine(line) !== null) return false;
      if (/^Cloning into .+\.\.\.$/.test(line)) return false;
      if (/^remote:\s+Enumerating objects:/i.test(line)) return false;
      if (/^remote:\s+Total \d+/i.test(line)) return false;
      return true;
    })
    .join("\n");
}

function cloneMessageFromUnknown(
  provider: ForgeProvider,
  cause: unknown
): string {
  if (provider.isAuthError(cause)) return provider.errorMessage(cause);
  if (!(cause instanceof Error)) return provider.errorMessage(cause);
  const stderr = (cause as Error & { stderr?: string }).stderr;
  const sanitized = sanitizeCloneStderr(stderr ?? "");
  return provider.errorMessage(sanitized || cause.message);
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
    private readonly forges: ForgeRegistry
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
    const [forgeStatuses, local] = await Promise.all([
      this.statuses(),
      this.localForgeState(repos)
    ]);
    const usable = new Set(
      forgeStatuses
        .filter((status) => status.installed && status.loggedIn)
        .map((status) => status.host)
    );

    const owners = dedupeOwners([
      ...local.owners,
      // The profile's default org is a guess about every signed-in forge: it
      // was a GitHub-only setting, and a person with both CLIs signed in
      // usually means the same org name on whichever one has it.
      ...(profile.org?.trim()
        ? [...usable].map(
            (host): OwnerCandidate => ({
              login: profile.org!.trim(),
              kind: "organization",
              host,
              probed: true
            })
          )
        : [])
    ]);

    const base: CloneCatalog = {
      owners: owners.map(({ login, kind, host }) => ({ login, kind, host })),
      repositories: [],
      forges: forgeStatuses
    };
    const listable = owners.filter((owner) => usable.has(owner.host));
    if (listable.length === 0) return ok(base);

    const failures: string[] = [];
    let authenticationMessage: string | undefined;
    const repositoriesByOwner = new Map<string, CloneRepository[]>();
    await mapLimit(listable, OWNER_CONCURRENCY, async (owner) => {
      const provider = this.forges.get(owner.host);
      if (provider === null) return;
      try {
        repositoriesByOwner.set(
          repoKey(owner.host, owner.login),
          await this.repositoriesForOwner(provider, owner.login)
        );
      } catch (cause) {
        if (
          authenticationMessage === undefined &&
          provider.isAuthError(cause)
        ) {
          authenticationMessage = provider.errorMessage(cause);
        } else if (!owner.probed) {
          failures.push(owner.login);
        }
        repositoriesByOwner.set(repoKey(owner.host, owner.login), []);
      }
    });

    const repositories = listable
      .flatMap(
        (owner) => repositoriesByOwner.get(repoKey(owner.host, owner.login)) ?? []
      )
      .filter(
        (repository, index, all) =>
          all.findIndex(
            (candidate) =>
              repoKey(candidate.host, candidate.nameWithOwner) ===
              repoKey(repository.host, repository.nameWithOwner)
          ) === index
      )
      .map((repository) => ({
        ...repository,
        localPaths:
          local.pathsByRepo.get(
            repoKey(repository.host, repository.nameWithOwner)
          ) ?? []
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

    const catalog: CloneCatalog = { ...base, repositories };
    if (authenticationMessage !== undefined) {
      catalog.warning = authenticationMessage;
    } else if (failures.length > 0) {
      catalog.warning = `Couldn't load repositories for ${failures.join(", ")}.`;
    }
    return ok(catalog);
  }

  destinations(
    profileId: string,
    includeNested: boolean
  ): Result<CloneDestination[]> {
    const profile = this.profiles.get(profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    return ok(
      cloneDestinations(
        this.db,
        profile,
        includeNested ? this.indexer.listRepos(profileId) : []
      )
    );
  }

  async checkSource(
    profileId: string,
    input: string,
    host: ForgeHost = "github"
  ): Promise<Result<CloneRepository>> {
    if (this.profiles.get(profileId) === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    const nameWithOwner = normalizeRepositoryPath(input);
    if (nameWithOwner === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: "Enter a repository as owner/name."
      });
    }
    const provider = this.forges.get(host);
    if (provider === null) {
      return err({
        kind: "remote",
        code: "unsupported_host",
        message: `PwrGit cannot look up repositories on ${host}.`
      });
    }
    const status = await provider.status();
    if (!status.installed) {
      return err({
        kind: "remote",
        code: "forge_cli_missing",
        message: `Install the ${host === "gitlab" ? "GitLab" : "GitHub"} CLI to look up repositories.`
      });
    }
    if (!status.loggedIn) {
      return err({
        kind: "remote",
        code: "forge_login_required",
        message: `Sign in with the ${host === "gitlab" ? "GitLab" : "GitHub"} CLI to look up repositories.`
      });
    }
    try {
      const repository = await provider.viewRepo(nameWithOwner);
      const local = await this.localForgeState(this.indexer.listRepos(profileId));
      repository.localPaths =
        local.pathsByRepo.get(
          repoKey(repository.host, repository.nameWithOwner)
        ) ?? [];
      return ok(repository);
    } catch (cause) {
      if (provider.isAuthError(cause)) {
        return err({
          kind: "remote",
          code: "forge_login_required",
          message: provider.errorMessage(cause)
        });
      }
      return err({
        kind: "remote",
        code: "repository_not_found",
        message: `Couldn't find ${nameWithOwner}. ${messageFromUnknown(provider, cause)}`
      });
    }
  }

  async clone(
    input: {
      profileId: string;
      nameWithOwner: string;
      protocol: CloneProtocol;
      parentPath: string;
      host?: ForgeHost;
      hostname?: string;
    },
    onProgress: (progress: CloneProgress) => void = () => undefined
  ): Promise<Result<Repo>> {
    const profile = this.profiles.get(input.profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${input.profileId}"`
      });
    }
    const nameWithOwner = normalizeRepositoryPath(input.nameWithOwner);
    if (nameWithOwner === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: "Enter a repository as owner/name."
      });
    }
    if (!(["ssh", "https", "cli"] as const).includes(input.protocol)) {
      return err({
        kind: "validation",
        code: "invalid_clone_protocol",
        message: "Choose SSH, HTTPS, or the forge CLI."
      });
    }
    const host = input.host ?? "github";
    const hostname = input.hostname ?? defaultHostname(host);
    // The hostname reaches this method from the renderer, and it is
    // interpolated straight into a git remote. Anything outside a bare
    // hostname could smuggle options or another host into the URL.
    if (!isSafeForgeHostname(hostname)) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: `Not a usable host: ${hostname}`
      });
    }

    const repoName = nameWithOwner.slice(nameWithOwner.lastIndexOf("/") + 1);
    const resolved = validateCheckoutDestination(
      profile,
      input.parentPath,
      repoName
    );
    if (!resolved.ok) return resolved;
    const { parentPath, destination } = resolved.value;

    onProgress({ phase: "starting", percent: null });
    const cloned = await this.runClone(
      { host, hostname, nameWithOwner, protocol: input.protocol },
      destination,
      parentPath,
      onProgress
    );
    if (!cloned.ok) return cloned;

    onProgress({ phase: "indexing", percent: null });
    const indexed = await this.indexer.indexRepoAt(input.profileId, destination);
    if (!indexed.ok) {
      return err({
        kind: "repo",
        code: "clone_index_failed",
        message: `Cloned to ${destination}, but couldn't add it to PwrGit: ${indexed.error.message}`
      });
    }
    this.rememberDestination(input.profileId, parentPath);
    return ok({
      ...indexed.value,
      path: canonicalExistingPath(indexed.value.path)
    });
  }

  /** Shared by clone and fork: run the transfer itself and normalize failure.
   *  Exposed so `ForkService` reuses the exact same protocol handling rather
   *  than growing a second copy that drifts. */
  async runClone(
    source: {
      host: ForgeHost;
      hostname: string;
      nameWithOwner: string;
      protocol: CloneProtocol;
    },
    destination: string,
    workingDirectory: string,
    onProgress: (progress: CloneProgress) => void
  ): Promise<Result<true>> {
    const readProgress = createCloneProgressParser(onProgress);
    const provider = this.forges.get(source.host);

    if (source.protocol === "cli") {
      if (provider === null) {
        return err({
          kind: "remote",
          code: "unsupported_host",
          message: `PwrGit has no CLI for ${source.host}. Clone with SSH or HTTPS.`
        });
      }
      try {
        await provider.cloneWithCli(source.nameWithOwner, destination, {
          onStderr: readProgress,
          env: CLONE_ENV
        });
      } catch (cause) {
        if (provider.isAuthError(cause)) {
          return err({
            kind: "remote",
            code: "forge_login_required",
            message: provider.errorMessage(cause)
          });
        }
        return err({
          kind: "git",
          code: "clone_failed",
          message: cloneMessageFromUnknown(provider, cause)
        });
      }
      return ok(true);
    }

    const urls = forgeCloneUrls(source.hostname, source.nameWithOwner);
    const remote = source.protocol === "ssh" ? urls.sshUrl : urls.httpsUrl;
    const cloned = await this.git(
      ["clone", "--progress", "--", remote, destination],
      workingDirectory,
      { onStderr: readProgress, env: CLONE_ENV }
    );
    if (!cloned.ok) return cloned;
    const checked = requireExit0(
      { ...cloned.value, stderr: sanitizeCloneStderr(cloned.value.stderr) },
      ["clone"]
    );
    if (!checked.ok) return checked;
    return ok(true);
  }

  /** Record an explicit checkout-folder choice for the MRU ordering. */
  rememberDestination(profileId: string, parentPath: string): void {
    this.db
      .prepare(
        `INSERT INTO clone_destinations (profile_id, path, last_used_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(profile_id, path) DO UPDATE SET last_used_at = datetime('now')`
      )
      .run(profileId, parentPath);
  }

  /** Every forge PwrGit knows about, whether or not its CLI is present. */
  async statuses(): Promise<ForgeStatus[]> {
    return Promise.all(this.forges.all().map((provider) => provider.status()));
  }

  private async repositoriesForOwner(
    provider: ForgeProvider,
    owner: string
  ): Promise<CloneRepository[]> {
    const key = repoKey(provider.host, owner);
    const cached = this.ownerCache.get(key);
    if (
      cached !== undefined &&
      Date.now() - cached.fetchedAt < OWNER_CACHE_TTL_MS
    ) {
      return cached.repositories;
    }
    const repositories = await provider.listRepos(owner, OWNER_REPO_LIMIT);
    this.ownerCache.set(key, { fetchedAt: Date.now(), repositories });
    return repositories;
  }

  private async localForgeState(repos: Repo[]): Promise<LocalForgeState> {
    const pathsByRepo = new Map<string, string[]>();
    const owners: OwnerCandidate[] = [];
    await mapLimit(repos, REMOTE_CONCURRENCY, async (repo) => {
      const result = await this.git(["remote", "-v"], repo.path);
      if (!result.ok || result.value.exitCode !== 0) return;
      const seen = new Set<string>();
      for (const line of result.value.stdout.split("\n")) {
        const url = /^\S+\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line)?.[1];
        if (url === undefined) continue;
        const parsed = parseForgeRemote(url);
        // `other` hosts have no provider, so listing their owners would offer
        // repositories nothing can fetch.
        if (parsed === null || parsed.host === "other") continue;
        const key = repoKey(parsed.host, parsed.nameWithOwner);
        if (seen.has(key)) continue;
        seen.add(key);
        if (
          !owners.some(
            (owner) =>
              owner.host === parsed.host &&
              owner.login.toLowerCase() === parsed.owner.toLowerCase()
          )
        ) {
          owners.push({
            login: parsed.owner,
            // A local remote cannot tell a user apart from an organization,
            // and nothing downstream needs the distinction for listing.
            kind: "organization",
            host: parsed.host,
            probed: false
          });
        }
        const paths = pathsByRepo.get(key) ?? [];
        const path = canonicalExistingPath(repo.path);
        if (!paths.includes(path)) paths.push(path);
        pathsByRepo.set(key, paths);
      }
    });
    return { owners, pathsByRepo };
  }
}

function defaultHostname(host: ForgeHost): string {
  return host === "gitlab" ? "gitlab.com" : "github.com";
}

function dedupeOwners(owners: OwnerCandidate[]): OwnerCandidate[] {
  return owners.filter(
    (owner, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.host === owner.host &&
          candidate.login.toLowerCase() === owner.login.toLowerCase()
      ) === index
  );
}
