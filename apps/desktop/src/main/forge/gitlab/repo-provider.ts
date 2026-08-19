import {
  forgeWebUrl,
  type CloneRepository,
  type ForgeStatus,
  type RepoVisibility
} from "@pwrgit/shared";
import { logMain } from "../../logs";
import {
  ownersFrom,
  parseJsonObject,
  splitNameWithOwner,
  UNAVAILABLE_STATUS,
  type ForgeRepoProvider,
  type ForkInput
} from "../repo-provider";
import {
  glabErrorMessage,
  isGlabAuthenticationError,
  runGlab,
  type GlabRunOptions
} from "./glab-cli";

const DEFAULT_HOSTNAME = "gitlab.com";
/** A fork is queued server-side; GitLab reports the copy through
 *  `import_status`. These bound the wait so a stuck import fails loudly. */
const IMPORT_POLL_INTERVAL_MS = 1_500;
const IMPORT_POLL_ATTEMPTS = 40;

type GlabRunner = (args: string[], options?: GlabRunOptions) => Promise<string>;

/** GitLab addresses a project by its URL-encoded full path. */
export function encodeProjectPath(nameWithOwner: string): string {
  return encodeURIComponent(nameWithOwner.replace(/\.git$/i, ""));
}

function text(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

function visibilityFrom(raw: unknown): RepoVisibility {
  if (typeof raw !== "string") return "unknown";
  const normalized = raw.trim().toLowerCase();
  return normalized === "public" ||
    normalized === "private" ||
    normalized === "internal"
    ? normalized
    : "unknown";
}

/** The hostname a project actually lives on, read from its own web URL so a
 *  self-hosted instance is named correctly rather than as gitlab.com. */
function hostnameFrom(webUrl: string | undefined, fallback: string): string {
  if (webUrl === undefined) return fallback;
  const matched = /^https?:\/\/([^/:]+)/i.exec(webUrl);
  return matched?.[1]?.toLowerCase() ?? fallback;
}

/** One GitLab project object (`GET /projects/:id` and every list endpoint). */
export function parseGitLabProject(
  raw: unknown,
  fallbackHostname = DEFAULT_HOSTNAME
): CloneRepository | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const nameWithOwner = text(row["path_with_namespace"]);
  if (nameWithOwner === undefined) return null;
  const split = splitNameWithOwner(nameWithOwner);
  if (split === null) return null;
  const webUrl = text(row["web_url"]);
  const hostname = hostnameFrom(webUrl, fallbackHostname);

  const repository: CloneRepository = {
    // `path` is the URL segment; `name` is the human title and may contain
    // spaces, so the path is what a checkout folder should be named after.
    name: text(row["path"]) ?? split.name,
    owner: split.owner,
    nameWithOwner,
    visibility: visibilityFrom(row["visibility"]),
    host: "gitlab",
    hostname,
    sshUrl:
      text(row["ssh_url_to_repo"]) ?? `git@${hostname}:${nameWithOwner}.git`,
    httpsUrl:
      text(row["http_url_to_repo"]) ??
      `${forgeWebUrl(hostname, nameWithOwner)}.git`,
    localPaths: []
  };
  const description = text(row["description"]);
  if (description !== undefined) repository.description = description;
  const updatedAt = text(row["last_activity_at"]) ?? text(row["updated_at"]);
  if (updatedAt !== undefined) repository.updatedAt = updatedAt;

  const forkedFrom = row["forked_from_project"];
  if (forkedFrom !== null && typeof forkedFrom === "object") {
    const parentRow = forkedFrom as Record<string, unknown>;
    const slug = text(parentRow["path_with_namespace"]);
    if (slug !== undefined) {
      repository.parent = {
        nameWithOwner: slug,
        url: text(parentRow["web_url"]) ?? forgeWebUrl(hostname, slug)
      };
    }
  }
  return repository;
}

export function parseGitLabProjects(
  stdout: string,
  fallbackHostname = DEFAULT_HOSTNAME
): CloneRepository[] {
  const parsed = parseJsonObject(stdout, "GitLab project list");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => parseGitLabProject(row, fallbackHostname))
    .filter((row): row is CloneRepository => row !== null);
}

export function parseGitLabUsername(stdout: string): string | null {
  const parsed = parseJsonObject(stdout, "GitLab account");
  if (parsed === null || typeof parsed !== "object") return null;
  return text((parsed as Record<string, unknown>)["username"]) ?? null;
}

/** Groups the user can create projects in. `full_path` (not `path`) is the
 *  addressable namespace for a subgroup. */
export function parseGitLabGroupPaths(stdout: string): string[] {
  const parsed = parseJsonObject(stdout, "GitLab groups");
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) =>
      row !== null && typeof row === "object"
        ? text((row as Record<string, unknown>)["full_path"]) ??
          text((row as Record<string, unknown>)["path"])
        : undefined
    )
    .filter((path): path is string => path !== undefined);
}

/** `import_status` on a freshly created fork. `none` and `finished` both mean
 *  the repository is ready to clone. */
export function forkImportFinished(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const status = text((raw as Record<string, unknown>)["import_status"]);
  return status === undefined || status === "finished" || status === "none";
}

export function forkImportFailed(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (text(row["import_status"]) !== "failed") return null;
  return text(row["import_error"]) ?? "GitLab could not finish copying the fork.";
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class GitLabRepoProvider implements ForgeRepoProvider {
  readonly host = "gitlab" as const;
  // GitLab has no default-branch-only fork option; the switch is hidden
  // rather than accepted and ignored.
  readonly capabilities = { defaultBranchOnly: false };

  constructor(
    private readonly glab: GlabRunner = runGlab,
    readonly hostname: string = DEFAULT_HOSTNAME
  ) {}

  async status(): Promise<ForgeStatus> {
    try {
      await this.glab(["--version"]);
    } catch (cause) {
      // Silent here once cost an hour chasing a dialog that said "install the
      // CLI" for an installed CLI. The status itself stays best-effort.
      logMain(
        "debug",
        "forge",
        `glab is not usable:`,
        this.errorMessage(cause)
      );
      return UNAVAILABLE_STATUS("gitlab");
    }
    let username: string | null = null;
    try {
      username = parseGitLabUsername(await this.glab(["api", "user"]));
    } catch {
      return { host: "gitlab", installed: true, loggedIn: false, owners: [] };
    }
    let groups: string[] = [];
    try {
      // min_access_level 30 is Developer — the floor for creating a project
      // in a group, which is what a fork target has to allow.
      groups = parseGitLabGroupPaths(
        await this.glab([
          "api",
          "groups?min_access_level=30&per_page=100&all_available=false"
        ])
      );
    } catch {
      // Personal-namespace forks still work without the group listing.
    }
    return {
      host: "gitlab",
      installed: true,
      loggedIn: true,
      owners: ownersFrom("gitlab", username, groups)
    };
  }

  async viewRepo(nameWithOwner: string): Promise<CloneRepository> {
    const project = await this.project(nameWithOwner);
    const repository = parseGitLabProject(project, this.hostname);
    if (repository === null) {
      throw new Error(`GitLab returned no project for ${nameWithOwner}`);
    }
    // GitLab reports only the immediate parent. Resolving the network root
    // costs one more read and is what makes `upstream` unambiguous for a fork
    // of a fork — the case the fork dialog has to ask about.
    if (repository.parent !== undefined) {
      const root = await this.resolveRoot(repository.parent.nameWithOwner);
      if (root !== null && root.nameWithOwner !== repository.parent.nameWithOwner) {
        repository.root = root;
      }
    }
    return repository;
  }

  async listRepos(owner: string, limit: number): Promise<CloneRepository[]> {
    const query = `per_page=${Math.min(limit, 100)}&order_by=last_activity_at&sort=desc`;
    // An owner is a group or a user and the endpoints differ. Groups are tried
    // first because a subgroup path can never be a username.
    try {
      return parseGitLabProjects(
        await this.glab([
          "api",
          `groups/${encodeProjectPath(owner)}/projects?include_subgroups=true&${query}`
        ]),
        this.hostname
      );
    } catch (cause) {
      if (this.isAuthError(cause)) throw cause;
    }
    return parseGitLabProjects(
      await this.glab(["api", `users/${encodeProjectPath(owner)}/projects?${query}`]),
      this.hostname
    );
  }

  async fork(input: ForkInput): Promise<CloneRepository> {
    const target = `${input.targetOwner}/${input.targetName}`;
    input.onPhase?.("creating");
    let created: unknown;
    try {
      // The REST endpoint is used rather than `glab repo fork` because it
      // returns the new project as JSON — including the import status the
      // clone has to wait on — and its parameters are stable across glab
      // versions in a way the command's flags are not.
      created = parseJsonObject(
        await this.glab(
          [
            "api",
            "--method",
            "POST",
            `projects/${encodeProjectPath(input.source)}/fork`,
            "--field",
            `namespace_path=${input.targetOwner}`,
            "--field",
            `name=${input.targetName}`,
            "--field",
            `path=${input.targetName}`
          ],
          { timeoutMs: 60_000 }
        ),
        "GitLab fork"
      );
    } catch (cause) {
      if (this.isAuthError(cause)) throw cause;
      // A name already taken in the namespace comes back as a 409 with a
      // "already exists"/"has already been taken" body. That is the
      // already-forked case — but only if the project sitting there actually
      // descends from the source. Any other failure (a group that forbids
      // forking, say) can leave an unrelated project at that path, and
      // returning it would have the caller clone a stranger's repository.
      const existing = await this.project(target).catch(() => null);
      const parsed =
        existing === null ? null : parseGitLabProject(existing, this.hostname);
      const descends =
        parsed?.parent?.nameWithOwner.toLowerCase() ===
        input.source.toLowerCase();
      if (!descends) throw cause;
      created = existing;
    }

    input.onPhase?.("awaiting_fork");
    const ready = await this.awaitImport(target, created);
    const repository = parseGitLabProject(ready, this.hostname);
    if (repository === null) {
      throw new Error(`GitLab returned no project for ${target}`);
    }
    return repository;
  }

  async cloneWithCli(
    nameWithOwner: string,
    destination: string,
    options: { onStderr: (chunk: string) => void; env: Record<string, string> }
  ): Promise<void> {
    await this.glab(["repo", "clone", nameWithOwner, destination, "--", "--progress"], {
      timeoutMs: 10 * 60_000,
      onStderr: options.onStderr,
      env: options.env
    });
  }

  isAuthError(cause: unknown): boolean {
    return isGlabAuthenticationError(cause);
  }

  errorMessage(cause: unknown): string {
    return glabErrorMessage(cause);
  }

  private async project(nameWithOwner: string): Promise<unknown> {
    return parseJsonObject(
      await this.glab(["api", `projects/${encodeProjectPath(nameWithOwner)}`]),
      "GitLab project"
    );
  }

  /** Walk the fork chain to its root, bounded — a cycle is impossible on the
   *  server but a bound keeps a malformed response from looping. */
  private async resolveRoot(
    startNameWithOwner: string
  ): Promise<{ nameWithOwner: string; url: string } | null> {
    let current = startNameWithOwner;
    for (let hop = 0; hop < 8; hop += 1) {
      let project: unknown;
      try {
        project = await this.project(current);
      } catch {
        return null;
      }
      const parsed = parseGitLabProject(project, this.hostname);
      if (parsed === null) return null;
      if (parsed.parent === undefined) {
        return {
          nameWithOwner: parsed.nameWithOwner,
          url: forgeWebUrl(parsed.hostname, parsed.nameWithOwner)
        };
      }
      current = parsed.parent.nameWithOwner;
    }
    return null;
  }

  private async awaitImport(
    nameWithOwner: string,
    created: unknown
  ): Promise<unknown> {
    let latest = created;
    for (let attempt = 0; attempt < IMPORT_POLL_ATTEMPTS; attempt += 1) {
      const failure = forkImportFailed(latest);
      if (failure !== null) throw new Error(failure);
      if (forkImportFinished(latest)) return latest;
      await sleep(IMPORT_POLL_INTERVAL_MS);
      latest = await this.project(nameWithOwner);
    }
    throw new Error(
      `GitLab is still copying ${nameWithOwner}. It will appear on GitLab shortly — clone it once the copy finishes.`
    );
  }
}
