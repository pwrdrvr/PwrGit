import { forgeWebUrl, type CloneRepository, type ForgeStatus, type RepoVisibility } from "@pwrgit/shared";
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
  ghErrorMessage,
  isGhAuthenticationError,
  runGh,
  type GhRunOptions
} from "../../github/gh-cli";

const HOSTNAME = "github.com";

/** Fields `gh repo list` and `gh repo view` are asked for. `visibility` (not
 *  `isPrivate`) is the one that can say "internal"; `parent` is what makes a
 *  fork legible without a second call. */
export const REPO_JSON_FIELDS =
  "name,nameWithOwner,description,visibility,isFork,parent,sshUrl,url,updatedAt";

type GhRunner = (args: string[], options?: GhRunOptions) => Promise<string>;

function visibilityFrom(raw: unknown): RepoVisibility {
  if (typeof raw !== "string") return "unknown";
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "public" ||
    normalized === "private" ||
    normalized === "internal"
  ) {
    return normalized;
  }
  return "unknown";
}

function text(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

/** One row of `gh repo list --json` / `gh repo view --json`. */
export function parseGhRepoJson(raw: unknown): CloneRepository | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const nameWithOwner = text(row["nameWithOwner"]);
  if (nameWithOwner === undefined) return null;
  const split = splitNameWithOwner(nameWithOwner);
  if (split === null) return null;

  const repository: CloneRepository = {
    name: text(row["name"]) ?? split.name,
    owner: split.owner,
    nameWithOwner,
    visibility: visibilityFrom(row["visibility"]),
    host: "github",
    hostname: HOSTNAME,
    sshUrl: text(row["sshUrl"]) ?? `git@${HOSTNAME}:${nameWithOwner}.git`,
    httpsUrl: text(row["url"]) ?? forgeWebUrl(HOSTNAME, nameWithOwner),
    localPaths: []
  };
  const description = text(row["description"]);
  if (description !== undefined) repository.description = description;
  const updatedAt = text(row["updatedAt"]);
  if (updatedAt !== undefined) repository.updatedAt = updatedAt;

  // `parent` is only populated when the repo is a fork; `isFork` without a
  // parent happens when the parent was deleted or is not visible to this
  // token — still a fork, with an unnameable origin.
  const parent = row["parent"];
  if (parent !== null && typeof parent === "object") {
    const parentRow = parent as Record<string, unknown>;
    const owner = parentRow["owner"];
    const login =
      owner !== null && typeof owner === "object"
        ? text((owner as Record<string, unknown>)["login"])
        : undefined;
    const parentName = text(parentRow["name"]);
    if (login !== undefined && parentName !== undefined) {
      const slug = `${login}/${parentName}`;
      repository.parent = { nameWithOwner: slug, url: forgeWebUrl(HOSTNAME, slug) };
    }
  }
  return repository;
}

/** REST reports `visibility` on every plan; the older `private` boolean is
 *  the fallback for an Enterprise API that omits it. Absent both, the answer
 *  is `unknown` — never `public`, which would understate where code can go. */
function restVisibility(row: Record<string, unknown>): RepoVisibility {
  const stated = visibilityFrom(row["visibility"]);
  if (stated !== "unknown") return stated;
  if (row["private"] === true) return "private";
  if (row["private"] === false) return "public";
  return "unknown";
}

export function parseGhRepoList(stdout: string): CloneRepository[] {
  const parsed = parseJsonObject(stdout, "GitHub repository list");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => parseGhRepoJson(row))
    .filter((row): row is CloneRepository => row !== null);
}

/** `gh api repos/{owner}/{repo}` — REST, snake_case, and the only GitHub
 *  response that carries `source` (the fork-network root) alongside `parent`. */
export function parseGhRestRepo(stdout: string): CloneRepository | null {
  const parsed = parseJsonObject(stdout, "GitHub repository");
  if (parsed === null || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const nameWithOwner = text(row["full_name"]);
  if (nameWithOwner === undefined) return null;
  const split = splitNameWithOwner(nameWithOwner);
  if (split === null) return null;

  const repository: CloneRepository = {
    name: text(row["name"]) ?? split.name,
    owner: split.owner,
    nameWithOwner,
    visibility: restVisibility(row),
    host: "github",
    hostname: HOSTNAME,
    sshUrl: text(row["ssh_url"]) ?? `git@${HOSTNAME}:${nameWithOwner}.git`,
    httpsUrl: text(row["html_url"]) ?? forgeWebUrl(HOSTNAME, nameWithOwner),
    localPaths: []
  };
  const description = text(row["description"]);
  if (description !== undefined) repository.description = description;
  const updatedAt = text(row["updated_at"]) ?? text(row["pushed_at"]);
  if (updatedAt !== undefined) repository.updatedAt = updatedAt;

  const refOf = (value: unknown): { nameWithOwner: string; url: string } | null => {
    if (value === null || typeof value !== "object") return null;
    const slug = text((value as Record<string, unknown>)["full_name"]);
    if (slug === undefined) return null;
    return {
      nameWithOwner: slug,
      url:
        text((value as Record<string, unknown>)["html_url"]) ??
        forgeWebUrl(HOSTNAME, slug)
    };
  };
  const parent = refOf(row["parent"]);
  if (parent !== null) repository.parent = parent;
  const source = refOf(row["source"]);
  // `source` equals `parent` for a fork of a source repo; recording it then
  // would make every fork look like it had an ambiguous upstream.
  if (source !== null && source.nameWithOwner !== parent?.nameWithOwner) {
    repository.root = source;
  }
  return repository;
}

export function parseGhLogin(stdout: string): string | null {
  const parsed = parseJsonObject(stdout, "GitHub account");
  if (parsed === null || typeof parsed !== "object") return null;
  return text((parsed as Record<string, unknown>)["login"]) ?? null;
}

export function parseGhOrgLogins(stdout: string): string[] {
  const parsed = parseJsonObject(stdout, "GitHub organizations");
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) =>
      row !== null && typeof row === "object"
        ? text((row as Record<string, unknown>)["login"])
        : undefined
    )
    .filter((login): login is string => login !== undefined);
}

export class GitHubRepoProvider implements ForgeRepoProvider {
  readonly host = "github" as const;
  readonly hostname = HOSTNAME;
  readonly capabilities = { defaultBranchOnly: true };

  constructor(private readonly gh: GhRunner = runGh) {}

  async status(): Promise<ForgeStatus> {
    try {
      await this.gh(["--version"]);
    } catch (cause) {
      // Silent here once cost an hour chasing a dialog that said "install the
      // CLI" for an installed CLI. The status itself stays best-effort.
      logMain(
        "debug",
        "forge",
        `gh is not usable:`,
        this.errorMessage(cause)
      );
      return UNAVAILABLE_STATUS("github");
    }
    let login: string | null = null;
    try {
      login = parseGhLogin(await this.gh(["api", "user"]));
    } catch {
      // Installed but not signed in — the dialogs render that distinctly from
      // "not installed", so it is not an error here.
      return { host: "github", installed: true, loggedIn: false, owners: [] };
    }
    let organizations: string[] = [];
    try {
      organizations = parseGhOrgLogins(
        await this.gh(["api", "user/orgs", "--paginate"])
      );
    } catch {
      // A token without `read:org` still forks into the personal account.
    }
    return {
      host: "github",
      installed: true,
      loggedIn: true,
      owners: ownersFrom("github", login, organizations)
    };
  }

  async viewRepo(nameWithOwner: string): Promise<CloneRepository> {
    const stdout = await this.gh(["api", `repos/${nameWithOwner}`]);
    const repository = parseGhRestRepo(stdout);
    if (repository === null) {
      throw new Error(`GitHub returned no repository for ${nameWithOwner}`);
    }
    return repository;
  }

  async listRepos(owner: string, limit: number): Promise<CloneRepository[]> {
    return parseGhRepoList(
      await this.gh([
        "repo",
        "list",
        owner,
        "--limit",
        String(limit),
        "--json",
        REPO_JSON_FIELDS
      ])
    );
  }

  async fork(input: ForkInput): Promise<CloneRepository> {
    const args = ["repo", "fork", input.source, "--clone=false"];
    // `gh` forks into the authenticated user unless told otherwise, so --org
    // is passed only for an organization target.
    if (input.targetOwnerKind === "organization") {
      args.push("--org", input.targetOwner);
    }
    const sourceName = splitNameWithOwner(input.source)?.name;
    if (input.targetName !== sourceName) {
      args.push("--fork-name", input.targetName);
    }
    if (input.defaultBranchOnly) args.push("--default-branch-only");
    input.onPhase?.("creating");
    // gh prints a human line on both "created" and "already exists"; the fork
    // is read back either way, which makes the two outcomes identical here.
    // `gh repo fork` already waits for GitHub to finish preparing the copy.
    await this.gh(args, { timeoutMs: 60_000 });
    input.onPhase?.("awaiting_fork");
    return this.viewRepo(`${input.targetOwner}/${input.targetName}`);
  }

  async cloneWithCli(
    nameWithOwner: string,
    destination: string,
    options: { onStderr: (chunk: string) => void; env: Record<string, string> }
  ): Promise<void> {
    await this.gh(
      ["repo", "clone", nameWithOwner, destination, "--", "--progress"],
      {
        timeoutMs: 10 * 60_000,
        onStderr: options.onStderr,
        env: options.env
      }
    );
  }

  isAuthError(cause: unknown): boolean {
    return isGhAuthenticationError(cause);
  }

  errorMessage(cause: unknown): string {
    return ghErrorMessage(cause);
  }
}
