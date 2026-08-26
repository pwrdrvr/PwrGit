import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import {
  forgeCloneUrls,
  forgeWebUrl,
  type CloneRepository,
  type ForgeKind,
  type ForgeOwner,
  type RepoVisibility
} from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import { requireExit0 } from "../git/dugite";
import {
  ForgeRepoRegistry,
  splitNameWithOwner,
  type ForgeRepoProvider,
  type ForkInput,
  type RepoSearch
} from "./repo-provider";
import { ForgeStatusService } from "./status";

/** A repository exposed by the hermetic Electron E2E forge. `remotePath` is
 *  an on-disk bare remote; the provider rewrites origin to the forge URL after
 *  cloning it so identity refresh still exercises the real remote parser. */
export type E2EForgeRepository = {
  remotePath: string;
  visibility?: RepoVisibility;
  description?: string;
  parent?: string;
  root?: string;
};

export type E2EForgeFailure = {
  kind: "auth" | "provider";
  message: string;
};

export type E2EForgeHostFixture = {
  hostname?: string;
  installed?: boolean;
  loggedIn?: boolean;
  owners: Omit<ForgeOwner, "host">[];
  repositories: Record<string, E2EForgeRepository>;
  /** Target slug -> the fork that becomes visible after `fork()` runs. */
  forks?: Record<string, E2EForgeRepository & { source: string }>;
  /** Keys are `view:<slug>`, `search`, `fork:<source>`, `clone:<slug>`. */
  errors?: Record<string, E2EForgeFailure>;
  cloneDelayMs?: number;
  /** Make an observable partial folder during clone delay. It is removed before
   *  a successful real clone and is owned by the service on cancellation. */
  partialDuringClone?: boolean;
  forkDelayMs?: number;
};

export type E2EForgeFixtureFile = {
  callsPath?: string;
  hosts: Partial<Record<ForgeKind, E2EForgeHostFixture>>;
};

class FixtureForgeError extends Error {
  constructor(
    message: string,
    readonly authentication: boolean
  ) {
    super(message);
    this.name = "FixtureForgeError";
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error("Fixture operation canceled."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Fixture operation canceled."));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class E2EForgeRepoProvider implements ForgeRepoProvider {
  readonly hostname: string;
  private readonly materialized = new Set<string>();

  constructor(
    readonly host: ForgeKind,
    private readonly fixturePath: string,
    private readonly git: GitExec
  ) {
    this.hostname =
      readFixture(this.fixturePath).hosts[this.host]?.hostname ??
      this.defaultHostname();
  }

  async owners(): Promise<ForgeOwner[]> {
    this.record("owners", {});
    this.failIfConfigured("owners");
    return this.hostConfig().owners.map((owner) => ({
      ...owner,
      host: this.host
    }));
  }

  async viewRepo(nameWithOwner: string): Promise<CloneRepository> {
    this.record("view", { nameWithOwner });
    this.failIfConfigured(`view:${nameWithOwner}`);
    const repository = this.repositoryConfig(nameWithOwner);
    if (repository === null) {
      throw new FixtureForgeError(`404 Not Found: ${nameWithOwner}`, false);
    }
    return this.repository(nameWithOwner, repository);
  }

  async searchRepos(input: RepoSearch): Promise<CloneRepository[]> {
    this.record("search", input);
    this.failIfConfigured("search");
    const query = input.query.trim().toLowerCase();
    const owners = input.owners.map((owner) => owner.toLowerCase());
    return Object.entries(this.hostConfig().repositories)
      .filter(([slug]) => {
        const split = splitNameWithOwner(slug);
        if (split === null) return false;
        const inOwner =
          owners.length === 0 ||
          owners.some(
            (owner) =>
              split.owner.toLowerCase() === owner ||
              split.owner.toLowerCase().startsWith(`${owner}/`)
          );
        return inOwner && (query === "" || slug.toLowerCase().includes(query));
      })
      .slice(0, input.limit)
      .map(([slug, repository]) => this.repository(slug, repository));
  }

  async fork(input: ForkInput): Promise<CloneRepository> {
    this.record("fork", {
      source: input.source,
      targetOwner: input.targetOwner,
      targetOwnerKind: input.targetOwnerKind,
      targetName: input.targetName,
      defaultBranchOnly: input.defaultBranchOnly
    });
    this.failIfConfigured(`fork:${input.source}`);
    input.onPhase?.("creating");
    await wait(this.hostConfig().forkDelayMs ?? 0, input.signal);
    const target = `${input.targetOwner}/${input.targetName}`;
    const fork = this.hostConfig().forks?.[target];
    if (
      fork === undefined ||
      fork.source.toLowerCase() !== input.source.toLowerCase()
    ) {
      throw new FixtureForgeError(
        `No fixture fork maps ${input.source} to ${target}.`,
        false
      );
    }
    this.materialized.add(target.toLowerCase());
    input.onPhase?.("awaiting_fork");
    return this.repository(target, fork);
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
    this.record("clone", { nameWithOwner, destination });
    this.failIfConfigured(`clone:${nameWithOwner}`);
    const repository = this.repositoryConfig(nameWithOwner);
    if (repository === null) {
      throw new FixtureForgeError(`404 Not Found: ${nameWithOwner}`, false);
    }
    const config = this.hostConfig();
    if (config.partialDuringClone === true) {
      mkdirSync(destination, { recursive: true });
      writeFileSync(
        `${destination}/PWRGIT_PARTIAL_CLONE`,
        "owned by the in-flight E2E clone\n"
      );
    }
    options.onStderr("remote: Counting objects: 25% (1/4)\r");
    options.onStderr(
      "Receiving objects: 50% (2/4), 2.00 KiB | 1.00 MiB/s\r"
    );
    await wait(config.cloneDelayMs ?? 0, options.signal);
    if (config.partialDuringClone === true) {
      rmSync(destination, { recursive: true, force: true });
    }

    const cloned = await this.git(
      ["clone", "--progress", "--", repository.remotePath, destination],
      dirname(destination),
      {
        onStderr: options.onStderr,
        env: options.env,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      }
    );
    if (!cloned.ok) throw new Error(cloned.error.message);
    const checked = requireExit0(cloned.value, ["clone"]);
    if (!checked.ok) throw new Error(checked.error.message);

    // A CLI clone uses the local fixture only as its transport. The checkout
    // still looks exactly like a real forge clone to the rest of PwrGit.
    const remote = forgeCloneUrls(this.hostname, nameWithOwner).sshUrl;
    const setUrl = await this.git(
      ["remote", "set-url", "origin", remote],
      destination,
      options.signal === undefined ? undefined : { signal: options.signal }
    );
    if (!setUrl.ok) throw new Error(setUrl.error.message);
    const urlChecked = requireExit0(setUrl.value, ["remote", "set-url"]);
    if (!urlChecked.ok) throw new Error(urlChecked.error.message);
  }

  isAuthError(cause: unknown): boolean {
    return cause instanceof FixtureForgeError && cause.authentication;
  }

  isNotFoundError(cause: unknown): boolean {
    return cause instanceof FixtureForgeError && /\b404\b/.test(cause.message);
  }

  errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  private repositoryConfig(nameWithOwner: string): E2EForgeRepository | null {
    const config = this.hostConfig();
    const direct = config.repositories[nameWithOwner];
    if (direct !== undefined) return direct;
    const fork = config.forks?.[nameWithOwner];
    return fork !== undefined &&
      this.materialized.has(nameWithOwner.toLowerCase())
      ? fork
      : null;
  }

  private repository(
    nameWithOwner: string,
    config: E2EForgeRepository
  ): CloneRepository {
    const split = splitNameWithOwner(nameWithOwner);
    if (split === null) {
      throw new FixtureForgeError(
        `Invalid fixture slug: ${nameWithOwner}`,
        false
      );
    }
    const urls = forgeCloneUrls(this.hostname, nameWithOwner);
    return {
      name: split.name,
      owner: split.owner,
      nameWithOwner,
      visibility: config.visibility ?? "public",
      host: this.host,
      hostname: this.hostname,
      sshUrl: urls.sshUrl,
      httpsUrl: urls.httpsUrl,
      localPaths: [],
      ...(config.description === undefined
        ? {}
        : { description: config.description }),
      ...(config.parent === undefined
        ? {}
        : {
            parent: {
              nameWithOwner: config.parent,
              url: forgeWebUrl(this.hostname, config.parent)
            }
          }),
      ...(config.root === undefined
        ? {}
        : {
            root: {
              nameWithOwner: config.root,
              url: forgeWebUrl(this.hostname, config.root)
            }
          })
    };
  }

  private failIfConfigured(key: string): void {
    const failure = this.hostConfig().errors?.[key];
    if (failure !== undefined) {
      throw new FixtureForgeError(failure.message, failure.kind === "auth");
    }
  }

  private hostConfig(): E2EForgeHostFixture {
    const config = readFixture(this.fixturePath).hosts[this.host];
    if (config === undefined) {
      throw new FixtureForgeError(`${this.host} is not configured.`, false);
    }
    return config;
  }

  private record(operation: string, input: unknown): void {
    const callsPath = readFixture(this.fixturePath).callsPath;
    if (callsPath !== undefined) {
      appendFileSync(
        callsPath,
        `${JSON.stringify({ host: this.host, operation, input })}\n`
      );
    }
  }

  private defaultHostname(): string {
    return this.host === "gitlab" ? "gitlab.com" : "github.com";
  }
}

function readFixture(path: string): E2EForgeFixtureFile {
  return JSON.parse(readFileSync(path, "utf8")) as E2EForgeFixtureFile;
}

/** Build the provider and cached-status seams used by Electron E2E. Nothing
 *  above this boundary is stubbed: renderer, IPC, services, Git, indexing,
 *  SQLite, selection and identity refresh all run normally. */
export function createE2EForgeFixtureServices(
  fixturePath: string,
  git: GitExec
): { forges: ForgeRepoRegistry; status: ForgeStatusService } {
  const forges = new ForgeRepoRegistry();
  for (const host of ["github", "gitlab"] as const) {
    forges.register(new E2EForgeRepoProvider(host, fixturePath, git));
  }
  const status = new ForgeStatusService({
    probes: (["github", "gitlab"] as const).map((host) => ({
      kind: host,
      cli: host === "github" ? "gh" : "glab",
      installed: async () => {
        const config = readFixture(fixturePath).hosts[host];
        return config !== undefined && config.installed !== false;
      },
      loggedIn: async () =>
        readFixture(fixturePath).hosts[host]?.loggedIn === true
    }))
  });
  return { forges, status };
}
