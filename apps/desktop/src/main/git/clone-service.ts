import { existsSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
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
  type CloneCatalog,
  type CloneDestination,
  type CloneProgress,
  type CloneProtocol,
  type CloneRepository,
  type ForgeHost,
  type ForgeOwner,
  type ForgeStatus,
  type Err,
  type Profile,
  type PwrGitError,
  type Repo,
  type Result
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import type { ProfileService } from "../profiles/profile-service";
import type {
  ForgeRepoProvider,
  ForgeRepoRegistry
} from "../forge/repo-provider";
import type { ForgeStatusService } from "../forge/status";
import { requireExit0, type GitExec } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";

/** How many repositories one search asks the forge for. A search result the
 *  user scrolls past 40 rows of is a query that needs narrowing, not a longer
 *  page. */
const SEARCH_LIMIT = 40;

type LocalForgeState = {
  owners: ForgeOwner[];
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

/** Resolve the absolute/home-relative forms the clone dialog recognizes.
 * Relative paths are intentionally rejected: the main process's cwd is an
 * implementation detail and would make the same text clone different repos. */
export function resolveLocalClonePath(
  input: string,
  homePath = homedir()
): string | null {
  const trimmed = input.trim();
  if (trimmed === "~") return resolve(homePath);
  if (/^~[\\/]/.test(trimmed)) {
    return resolve(homePath, trimmed.slice(2));
  }
  if (!isAbsolute(trimmed)) return null;
  return resolve(trimmed);
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

function messageFromUnknown(provider: ForgeRepoProvider, cause: unknown): string {
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
  provider: ForgeRepoProvider,
  cause: unknown
): string {
  if (provider.isAuthError(cause)) return provider.errorMessage(cause);
  if (!(cause instanceof Error)) return provider.errorMessage(cause);
  const stderr = (cause as Error & { stderr?: string }).stderr;
  const sanitized = sanitizeCloneStderr(stderr ?? "");
  return provider.errorMessage(sanitized || cause.message);
}

function cancellationError(
  signal: AbortSignal,
  fallbackMessage: string
): PwrGitError {
  const reason = signal.reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "kind" in reason &&
    "code" in reason &&
    "message" in reason
  ) {
    return reason as PwrGitError;
  }
  return {
    kind: "git",
    code: "aborted",
    message: fallbackMessage,
    cause: reason
  };
}

export function operationWasCanceled(
  signal: AbortSignal | undefined
): signal is AbortSignal {
  return signal?.aborted === true;
}

/** A validated clone destination did not exist before this operation, so a
 *  failed/canceled transfer owns everything now at that exact path. */
export async function removePartialCheckout(
  destination: string
): Promise<boolean> {
  try {
    await rm(destination, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50
    });
    return true;
  } catch {
    // Preserve the actionable transfer error. A locked file on Windows may
    // prevent best-effort cleanup, but must not turn "authentication failed"
    // into a raw filesystem diagnostic.
    return false;
  }
}

export class CloneService {
  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    private readonly indexer: RepoIndexer,
    private readonly profiles: ProfileService,
    private readonly forges: ForgeRepoRegistry,
    private readonly forgeStatus: ForgeStatusService
  ) {}

  /**
   * What the dialogs need to open: which accounts to scope a search to, and
   * which forges can answer one.
   *
   * Costs no forge call and no subprocess. It used to list every owner's
   * repositories here — one `gh repo list` per account, three at a time —
   * which is why the dialog sat on "Loading repositories…" for ten seconds
   * before the user had typed anything. Repositories now come from
   * `searchSources`, on settled input.
   */
  async catalog(profileId: string): Promise<Result<CloneCatalog>> {
    const profile = this.profiles.get(profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    const forges = await this.statuses();
    const local = localForgeState(this.indexer.listRepos(profileId));
    return ok({ owners: knownOwners(profile, forges, local), forges });
  }

  /**
   * Repositories matching what the user typed, from the forge's own search.
   *
   * `owner/term` scopes to that owner, which is what makes a half-typed slug
   * useful — `pwrdrvr/micro` lists the account's matches instead of only
   * 404-ing as an exact name. A bare term searches the accounts already in
   * this profile, or the whole forge when there are none yet.
   */
  async searchSources(
    profileId: string,
    input: string,
    host: ForgeHost = "github"
  ): Promise<Result<CloneRepository[]>> {
    const profile = this.profiles.get(profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${profileId}"`
      });
    }
    const provider = this.forges.get(host);
    if (provider === null) {
      return err({
        kind: "remote",
        code: "unsupported_host",
        message: `PwrGit cannot search repositories on ${host}.`
      });
    }
    const forges = await this.statuses();
    const unavailable = forgeUnavailable(forges, host);
    if (unavailable !== null) return unavailable;

    const parsed = parseSearchInput(input);
    if (parsed === null) return ok([]);
    // Read once and used twice — for the owners a bare term is scoped to, and
    // for the checkouts each result is marked with. `listRepos` is two queries
    // plus an ownership pass over every worktree, and this runs on every
    // settled keystroke.
    const local = localForgeState(this.indexer.listRepos(profileId));
    const owners =
      parsed.owner !== null
        ? [parsed.owner]
        : knownOwners(profile, forges, local)
            .filter((owner) => owner.host === host)
            .map((owner) => owner.login);

    try {
      const found = await provider.searchRepos({
        query: parsed.term,
        owners,
        limit: SEARCH_LIMIT
      });
      return ok(
        found.map((repository) => ({
          ...repository,
          localPaths:
            local.pathsByRepo.get(
              repoKey(repository.host, repository.nameWithOwner)
            ) ?? []
        }))
      );
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
        code: "search_failed",
        message: messageFromUnknown(provider, cause)
      });
    }
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
    const unavailable = forgeUnavailable(await this.statuses(), host);
    if (unavailable !== null) return unavailable;
    try {
      const repository = await provider.viewRepo(nameWithOwner);
      const local = localForgeState(this.indexer.listRepos(profileId));
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

  async checkLocalSource(
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
    return this.localSource(input);
  }

  private async localSource(input: string): Promise<Result<CloneRepository>> {
    const path = resolveLocalClonePath(input);
    if (path === null) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: "Enter an absolute repository path or one beginning with ~/."
      });
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      // The validation result below keeps raw filesystem errors out of IPC.
    }
    if (!isDirectory) {
      return err({
        kind: "validation",
        code: "local_source_missing",
        message: `No repository folder exists at ${path}`
      });
    }
    const canonical = canonicalExistingPath(path);
    const probeArgs = ["rev-parse", "--git-dir"];
    const probe = await this.git(probeArgs, canonical);
    if (!probe.ok) return probe;
    const checked = requireExit0(probe.value, probeArgs);
    if (!checked.ok) {
      return err({
        kind: "validation",
        code: "not_a_repo",
        message: `No Git repository found at ${canonical}`
      });
    }
    const name = basename(canonical).replace(/\.git$/i, "") || "repository";
    return ok({
      name,
      owner: "Local",
      nameWithOwner: canonical,
      description: "Local Git repository",
      visibility: "unknown",
      host: "other",
      hostname: "local",
      sshUrl: canonical,
      httpsUrl: canonical,
      localPath: canonical,
      localPaths: []
    });
  }

  async clone(
    input: {
      profileId: string;
      nameWithOwner: string;
      sourcePath?: string;
      protocol: CloneProtocol;
      parentPath: string;
      host?: ForgeHost;
      hostname?: string;
    },
    onProgress: (progress: CloneProgress) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<Result<Repo>> {
    const profile = this.profiles.get(input.profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${input.profileId}"`
      });
    }
    const local =
      input.sourcePath === undefined
        ? null
        : await this.localSource(input.sourcePath);
    if (local !== null && !local.ok) return local;
    const nameWithOwner =
      local?.ok === true
        ? local.value.nameWithOwner
        : normalizeRepositoryPath(input.nameWithOwner);
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
    const host = local?.ok === true ? "other" : (input.host ?? "github");
    const hostname =
      local?.ok === true ? "local" : (input.hostname ?? defaultHostname(host));
    // The hostname reaches this method from the renderer, and it is
    // interpolated straight into a git remote. Anything outside a bare
    // hostname could smuggle options or another host into the URL.
    if (local === null && !isSafeForgeHostname(hostname)) {
      return err({
        kind: "validation",
        code: "invalid_repository",
        message: `Not a usable host: ${hostname}`
      });
    }

    const repoName =
      local?.ok === true
        ? local.value.name
        : nameWithOwner.slice(nameWithOwner.lastIndexOf("/") + 1);
    const resolved = validateCheckoutDestination(
      profile,
      input.parentPath,
      repoName
    );
    if (!resolved.ok) return resolved;
    const { parentPath, destination } = resolved.value;

    if (operationWasCanceled(signal)) {
      return err(cancellationError(signal, "Clone canceled."));
    }

    onProgress({ phase: "starting", percent: null });
    const cloned = await this.runClone(
      {
        host,
        hostname,
        nameWithOwner,
        protocol: input.protocol,
        ...(local?.ok === true ? { localPath: local.value.localPath } : {})
      },
      destination,
      parentPath,
      onProgress,
      signal
    );
    if (!cloned.ok) {
      const cleaned = await removePartialCheckout(destination);
      if (operationWasCanceled(signal)) {
        return err({
          ...cancellationError(signal, "Clone canceled."),
          message: cleaned
            ? "Clone canceled. No partial checkout was kept."
            : `Clone canceled, but PwrGit could not remove ${destination}. Remove it before retrying.`
        });
      }
      return cloned;
    }
    if (operationWasCanceled(signal)) {
      const cleaned = await removePartialCheckout(destination);
      return err({
        ...cancellationError(signal, "Clone canceled."),
        message: cleaned
          ? "Clone canceled. No partial checkout was kept."
          : `Clone canceled, but PwrGit could not remove ${destination}. Remove it before retrying.`
      });
    }

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
      localPath?: string;
    },
    destination: string,
    workingDirectory: string,
    onProgress: (progress: CloneProgress) => void,
    signal?: AbortSignal
  ): Promise<Result<true>> {
    const readProgress = createCloneProgressParser(onProgress);
    if (source.localPath !== undefined) {
      const cloned = await this.git(
        ["clone", "--progress", "--", source.localPath, destination],
        workingDirectory,
        {
          onStderr: readProgress,
          env: CLONE_ENV,
          ...(signal === undefined ? {} : { signal })
        }
      );
      if (!cloned.ok) return cloned;
      const checked = requireExit0(
        { ...cloned.value, stderr: sanitizeCloneStderr(cloned.value.stderr) },
        ["clone"]
      );
      return checked.ok ? ok(true) : checked;
    }
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
          env: CLONE_ENV,
          ...(signal === undefined ? {} : { signal })
        });
      } catch (cause) {
        if (operationWasCanceled(signal)) {
          return err(cancellationError(signal, "Clone canceled."));
        }
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
      {
        onStderr: readProgress,
        env: CLONE_ENV,
        ...(signal === undefined ? {} : { signal })
      }
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

  /** Every forge PwrGit knows about, whether or not its CLI is present.
   *  Delegated to the app-wide cached probe rather than asking each provider:
   *  a probe is a subprocess, and this runs every time a dialog opens. */
  async statuses(): Promise<ForgeStatus[]> {
    return this.forgeStatus.list();
  }
}

/** Accounts this profile has already used, plus its configured default org.
 *
 *  Read entirely from what `repo:list` already carries — `repo_identity`,
 *  joined on in SQLite — so it costs one query the indexer has run anyway.
 *  Takes the local state rather than reading it, so a caller that also needs
 *  `pathsByRepo` pays for the pass once.
 *
 *  Fork parents count: a checkout of your fork of `openai/codex` is how you
 *  came to care about `openai`, and the old owner scan saw the same account
 *  through that checkout's `upstream` remote. */
function knownOwners(
  profile: Profile,
  forges: ForgeStatus[],
  local: LocalForgeState
): ForgeOwner[] {
  const usable = new Set(
    forges
      .filter((status) => status.installed && status.loggedIn)
      .map((status) => status.kind)
  );
  return dedupeOwners([
    ...local.owners,
    // The profile's default org is a guess about every signed-in forge: it
    // was a GitHub-only setting, and a person with both CLIs signed in
    // usually means the same org name on whichever one has it.
    ...(profile.org?.trim()
      ? [...usable].map(
          (candidate): ForgeOwner => ({
            login: profile.org!.trim(),
            kind: "organization",
            host: candidate
          })
        )
      : [])
  ]).filter((owner) => usable.has(owner.host));
}

/** Split what is in the search box into an optional owner and a term.
 *
 *  `pwrdrvr/micro` scopes to `pwrdrvr` and searches for `micro`; `pwrdrvr/`
 *  scopes with nothing to match, which the forges answer with that account's
 *  most recent repositories. A bare term has no owner. Returns null when
 *  there is nothing to search at all — an empty box must not become a request
 *  for everything.
 *
 *  GitLab nests subgroups, so the owner is everything before the LAST slash;
 *  `group/sub/proj` searches `proj` inside `group/sub`. */
export function parseSearchInput(
  input: string
): { owner: string | null; term: string } | null {
  const trimmed = input.trim().replace(/^\/+/, "");
  if (trimmed === "") return null;
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) return { owner: null, term: trimmed };
  const owner = trimmed.slice(0, lastSlash);
  const term = trimmed.slice(lastSlash + 1).replace(/\.git$/i, "");
  return isSafeProjectPath(`${owner}/x`) ? { owner, term } : null;
}

/** The forge-availability error, or null when the forge can answer.
 *
 *  Shared by every read that talks to a provider so the two cannot drift: the
 *  dialogs key off these exact codes to fall back to an unverified row rather
 *  than showing a failure. */
function forgeUnavailable(
  statuses: ForgeStatus[],
  host: ForgeHost
): Err<PwrGitError> | null {
  const status = statuses.find((candidate) => candidate.kind === host);
  const label = host === "gitlab" ? "GitLab" : "GitHub";
  if (status === undefined || !status.installed) {
    return err({
      kind: "remote",
      code: "forge_cli_missing",
      message: `Install the ${label} CLI to look up repositories.`
    });
  }
  if (!status.loggedIn) {
    return err({
      kind: "remote",
      code: "forge_login_required",
      message: `Sign in with the ${label} CLI to look up repositories.`
    });
  }
  return null;
}

/** Owners and existing checkouts, read from the identities already joined onto
 *  `repo:list`.
 *
 *  Pure and synchronous, and that is the point: the version this replaced ran
 *  `git remote -v` in every indexed repository — 52 subprocesses on this
 *  author's profile — on every catalog read AND on every exact-name check.
 *  `repo_identity` holds the same answer, written by the background refresh
 *  that already runs at launch.
 *
 *  Fork parents count as owners. A checkout of your fork of `openai/codex` is
 *  how you came to care about `openai`, and the remote scan saw that account
 *  through the same checkout's `upstream`. */
function localForgeState(repos: Repo[]): LocalForgeState {
  const pathsByRepo = new Map<string, string[]>();
  const owners: ForgeOwner[] = [];
  const addOwner = (host: ForgeHost, login: string): void => {
    // `other` hosts have no provider, so offering their owners would scope a
    // search to accounts nothing can search.
    if (host === "other" || login === "") return;
    if (
      !owners.some(
        (owner) =>
          owner.host === host &&
          owner.login.toLowerCase() === login.toLowerCase()
      )
    ) {
      // A stored identity cannot tell a user apart from an organization, and
      // nothing downstream needs the distinction for searching.
      owners.push({ login, kind: "organization", host });
    }
  };

  for (const repo of repos) {
    const identity = repo.identity;
    if (identity === undefined) continue;
    addOwner(identity.host, identity.owner);
    for (const related of [identity.parent, identity.root]) {
      if (related === undefined) continue;
      const split = splitOwner(related.nameWithOwner);
      if (split !== null) addOwner(identity.host, split);
    }
    if (identity.host === "other") continue;
    const key = repoKey(identity.host, identity.nameWithOwner);
    const paths = pathsByRepo.get(key) ?? [];
    const path = canonicalExistingPath(repo.path);
    if (!paths.includes(path)) paths.push(path);
    pathsByRepo.set(key, paths);
  }
  return { owners, pathsByRepo };
}

function splitOwner(nameWithOwner: string): string | null {
  const lastSlash = nameWithOwner.lastIndexOf("/");
  return lastSlash <= 0 ? null : nameWithOwner.slice(0, lastSlash);
}

function defaultHostname(host: ForgeHost): string {
  return host === "gitlab" ? "gitlab.com" : "github.com";
}

function dedupeOwners(owners: ForgeOwner[]): ForgeOwner[] {
  return owners.filter(
    (owner, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.host === owner.host &&
          candidate.login.toLowerCase() === owner.login.toLowerCase()
      ) === index
  );
}
