import {
  forgeWebUrl,
  type CloneRepository,
  type ForgeOwner,
  type RepoVisibility
} from "@pwrgit/shared";
import { logMain } from "../../logs";
import {
  ownersFrom,
  parseJsonObject,
  splitNameWithOwner,
  type ForgeRepoProvider,
  type ForkInput,
  type RepoSearch
} from "../repo-provider";
import {
  ghErrorMessage,
  isGhAuthenticationError,
  runGh,
  type GhRunOptions
} from "../../github/gh-cli";

const HOSTNAME = "github.com";

/** `gh search repos` is a different command with a different vocabulary: the
 *  slug is `fullName`, there is no `sshUrl`, and there is no `parent` — the
 *  search index does not carry fork lineage. Both gaps are filled in when a
 *  row is picked and `viewRepo` reads the repository properly. */
export const SEARCH_JSON_FIELDS =
  "name,fullName,description,visibility,isPrivate,updatedAt,url";

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

/** Search reports `visibility` like the rest of `gh`, with `isPrivate` as the
 *  older boolean beside it. Same rule as `restVisibility`: absent both, the
 *  answer is `unknown` rather than `public`. */
function searchVisibility(row: Record<string, unknown>): RepoVisibility {
  const stated = visibilityFrom(row["visibility"]);
  if (stated !== "unknown") return stated;
  if (row["isPrivate"] === true) return "private";
  if (row["isPrivate"] === false) return "public";
  return "unknown";
}

/** One row of `gh search repos --json`. Kept apart from `parseGhRestRepo`
 *  rather than made tolerant of both shapes: a parser that accepts either key
 *  for the slug silently returns `[]` when a field is renamed, instead of
 *  failing where the command was invoked. */
export function parseGhSearchRepoJson(raw: unknown): CloneRepository | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const nameWithOwner = text(row["fullName"]);
  if (nameWithOwner === undefined) return null;
  const split = splitNameWithOwner(nameWithOwner);
  if (split === null) return null;

  const repository: CloneRepository = {
    name: text(row["name"]) ?? split.name,
    owner: split.owner,
    nameWithOwner,
    visibility: searchVisibility(row),
    host: "github",
    hostname: HOSTNAME,
    // Search does not return clone URLs; both forms are a pure function of the
    // slug on github.com, so deriving them costs nothing and invents nothing.
    sshUrl: `git@${HOSTNAME}:${nameWithOwner}.git`,
    httpsUrl: text(row["url"]) ?? forgeWebUrl(HOSTNAME, nameWithOwner),
    localPaths: []
  };
  const description = text(row["description"]);
  if (description !== undefined) repository.description = description;
  const updatedAt = text(row["updatedAt"]);
  if (updatedAt !== undefined) repository.updatedAt = updatedAt;
  return repository;
}

export function parseGhSearchRepos(stdout: string): CloneRepository[] {
  const parsed = parseJsonObject(stdout, "GitHub repository search");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => parseGhSearchRepoJson(row))
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

  constructor(private readonly gh: GhRunner = runGh) {}

  async owners(): Promise<ForgeOwner[]> {
    const login = parseGhLogin(await this.gh(["api", "user"]));
    let organizations: string[] = [];
    try {
      organizations = parseGhOrgLogins(
        await this.gh(["api", "user/orgs", "--paginate"])
      );
    } catch {
      // A token without `read:org` can still fork into the personal account.
    }
    return ownersFrom("github", login, organizations);
  }

  async viewRepo(
    nameWithOwner: string,
    signal?: AbortSignal
  ): Promise<CloneRepository> {
    const args = ["api", `repos/${nameWithOwner}`];
    const stdout = await (signal === undefined
      ? this.gh(args)
      : this.gh(args, { signal }));
    const repository = parseGhRestRepo(stdout);
    if (repository === null) {
      throw new Error(`GitHub returned no repository for ${nameWithOwner}`);
    }
    return repository;
  }

  async searchRepos({
    query,
    owners,
    limit
  }: RepoSearch): Promise<CloneRepository[]> {
    const term = query.trim();
    // `gh search repos` rejects a call with neither a term nor a qualifier,
    // and rightly so — that is a request for all of GitHub.
    if (term === "" && owners.length === 0) return [];
    const args = ["search", "repos"];
    for (const owner of owners) args.push(`--owner=${owner}`);
    // `gh`'s default sort is best-match, which is what puts a typed name at
    // the top. With no term there is nothing to match on, so recency is the
    // only ordering that means anything — that is the `owner/` case, where the
    // user has named an account and wants to see what is in it.
    if (term === "") args.push("--sort", "updated");
    args.push("--limit", String(limit), "--json", SEARCH_JSON_FIELDS);
    // The term goes last, behind `--`. It is arbitrary user input, and `gh`
    // reads a leading dash as a flag: searching for `-ui` fails with "unknown
    // shorthand flag: 'u'", and a term of `--json` swallows the argument after
    // it. There is no shell involved — the runner spawns an argv array — so
    // this is about `gh`'s own parser, not injection.
    if (term !== "") args.push("--", term);
    return parseGhSearchRepos(await this.gh(args));
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
    await this.gh(args, {
      timeoutMs: 60_000,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    input.onPhase?.("awaiting_fork");
    return this.viewRepo(
      `${input.targetOwner}/${input.targetName}`,
      input.signal
    );
  }

  async cloneWithCli(
    nameWithOwner: string,
    destination: string,
    options: {
      onStderr: (chunk: string) => void;
      env: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<void> {
    await this.gh(
      ["repo", "clone", nameWithOwner, destination, "--", "--progress"],
      {
        timeoutMs: 10 * 60_000,
        onStderr: options.onStderr,
        env: options.env,
        ...(options.signal === undefined ? {} : { signal: options.signal })
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
