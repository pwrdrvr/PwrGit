import { setTimeout as delay } from "node:timers/promises";
import type { CloneRepository, ForgeOwner, ForgeRepoRef } from "@pwrgit/shared";
import {
  ForgeResponseError,
  type ForgeRepoProvider,
  type RepoSearch,
  type ForkInput
} from "../repo-provider";
import {
  cafeClient,
  cafeHostArgs,
  cafePage,
  cafeResource,
  object,
  runCafe,
  type CafeRunner
} from "./cafe-cli";
import type { CliRunOptions } from "../cli-runner";

function coordinates(row: Record<string, unknown>): {
  owner: string;
  name: string;
} {
  if (
    typeof row.owner !== "string" ||
    typeof row.name !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(row.owner) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(row.name)
  ) {
    throw new ForgeResponseError(
      "GitCafe returned invalid repository coordinates."
    );
  }
  return { owner: row.owner, name: row.name };
}
export function parseCafeRepo(
  value: unknown,
  hostname: string
): CloneRepository {
  const row = object(value);
  const { owner, name } = coordinates(row);
  if (row.visibility !== "public" && row.visibility !== "private") {
    throw new ForgeResponseError("GitCafe returned no repository visibility.");
  }
  let parent: ForgeRepoRef | undefined;
  if (row.parent !== undefined && row.parent !== null) {
    const source = coordinates(object(row.parent));
    parent = {
      url: `https://${hostname}/${source.owner}/${source.name}`,
      nameWithOwner: `${source.owner}/${source.name}`
    };
  }
  return {
    host: "gitcafe",
    hostname,
    owner,
    name,
    nameWithOwner: `${owner}/${name}`,
    visibility: row.visibility,
    // cafe clone uses HTTPS and installs its own credential helper per call.
    httpsUrl: `https://${hostname}/${owner}/${name}.git`,
    sshUrl: `git@${hostname}:${owner}/${name}.git`,
    localPaths: [],
    ...(parent === undefined ? {} : { parent }),
    ...(typeof row.description === "string"
      ? { description: row.description }
      : {}),
    ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {})
  };
}
export class GitCafeRepoProvider implements ForgeRepoProvider {
  readonly host = "gitcafe" as const;
  constructor(
    private readonly run: CafeRunner = runCafe,
    readonly hostname = "git.cafe"
  ) {}
  private command(args: string[], options?: CliRunOptions): Promise<string> {
    return this.run([...args, ...cafeHostArgs(this.hostname)], options);
  }
  async owners(): Promise<ForgeOwner[]> {
    const page = cafePage(await this.command(["org", "list", "--json"]));
    if (page.nextCursor !== null)
      throw new ForgeResponseError(
        "GitCafe returned an incomplete organization list."
      );
    return page.items.map((value) => {
      const row = object(value);
      if (typeof row.handle !== "string" || typeof row.personal !== "boolean")
        throw new ForgeResponseError(
          "GitCafe returned an invalid organization."
        );
      return {
        login: row.handle,
        kind: row.personal ? "user" : "organization",
        host: this.host
      };
    });
  }
  async viewRepo(nameWithOwner: string): Promise<CloneRepository> {
    return this.readRepo(nameWithOwner);
  }
  private async readRepo(
    nameWithOwner: string,
    signal?: AbortSignal
  ): Promise<CloneRepository> {
    const repo = parseCafeRepo(
      cafeResource(
        await this.command(
          ["repo", "view", nameWithOwner, "--json"],
          signal === undefined ? {} : { signal }
        )
      ),
      this.hostname
    );
    if (repo.nameWithOwner.toLowerCase() !== nameWithOwner.toLowerCase())
      throw new ForgeResponseError("GitCafe returned a different repository.");
    return repo;
  }
  async searchRepos(input: RepoSearch): Promise<CloneRepository[]> {
    if (input.query.trim() === "" && input.owners.length !== 1) return [];
    // cafe has no repository search command yet. One bounded, on-demand page
    // of accessible repositories, filtered locally; never enumerate per owner.
    const page = cafePage(
      await this.command([
        "repo",
        "list",
        "--limit",
        "50",
        "--json",
        ...(input.owners.length === 1 ? ["--org", input.owners[0]!] : [])
      ])
    );
    const owners = new Set(input.owners.map((owner) => owner.toLowerCase()));
    const query = input.query.trim().toLowerCase();
    return page.items
      .map((row) => parseCafeRepo(row, this.hostname))
      .filter(
        (repo) =>
          (owners.size === 0 || owners.has(repo.owner.toLowerCase())) &&
          `${repo.nameWithOwner} ${repo.description ?? ""}`
            .toLowerCase()
            .includes(query)
      )
      .slice(0, input.limit);
  }
  async fork(input: ForkInput): Promise<CloneRepository> {
    input.signal?.throwIfAborted();
    input.onPhase?.("creating");
    // Supplying the chosen owner for personal accounts too prevents a stale
    // account selection from forking into a different default account.
    const admission = cafeResource(
      await this.command(
        [
          "repo",
          "fork",
          input.source,
          "--org",
          input.targetOwner,
          "--name",
          input.targetName,
          "--json"
        ],
        {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          timeoutMs: 60_000
        }
      )
    );
    if (
      admission.name !== input.targetName ||
      typeof admission.state !== "string"
    ) {
      throw new ForgeResponseError(
        "GitCafe returned an invalid fork admission."
      );
    }
    input.onPhase?.("awaiting_fork");
    const path = `${input.targetOwner}/${input.targetName}`;
    if (admission.state === "blocked")
      throw new Error(
        `GitCafe blocked the fork ${path}; inspect it in GitCafe.`
      );
    for (let attempt = 0; attempt < 30; attempt++) {
      input.signal?.throwIfAborted();
      try {
        return await this.readRepo(path, input.signal);
      } catch (error) {
        if (!this.isNotFoundError(error)) throw error;
      }
      await delay(1_000, undefined, { signal: input.signal });
    }
    throw new Error(
      `GitCafe is still preparing ${path}. The fork was requested; check GitCafe before retrying.`
    );
  }
  async cloneWithCli(
    nameWithOwner: string,
    destination: string,
    options: Parameters<ForgeRepoProvider["cloneWithCli"]>[2]
  ): Promise<void> {
    await this.command(
      ["repo", "clone", nameWithOwner, destination, "--json"],
      { ...options, timeoutMs: 30 * 60_000 }
    );
  }
  isAuthError = cafeClient.isAuthenticationError;
  isNotFoundError(cause: unknown): boolean {
    return (
      cafeClient.isNotFoundError(cause) ||
      (cause instanceof Error && /\bNOT_FOUND\b/.test(cause.message))
    );
  }
  errorMessage = cafeClient.errorMessage;
}
