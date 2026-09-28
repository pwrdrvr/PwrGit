import type { CloneRepository } from "@pwrgit/shared";
import type { ForgeRepoProvider } from "../repo-provider";
import { GerritError, gerritGet, type GerritGet } from "./client";

/** Only repository identity is implemented; account/fork/search/CLI workflows
 * are disabled by the product's workflow capabilities before reaching here. */
export class GerritRepoProvider implements ForgeRepoProvider {
  readonly host = "gerrit" as const;
  constructor(readonly hostname: string, private readonly reviewUrl: () => string | undefined = () => undefined, private readonly get: GerritGet = gerritGet) {}
  async viewRepo(path: string): Promise<CloneRepository> {
    const value = await this.get({ kind: this.host, host: this.hostname, path, reviewUrl: this.reviewUrl() }, `projects/${encodeURIComponent(path)}`);
    if (value === null || typeof value !== "object" || !("id" in value) || value.id !== encodeURIComponent(path)) throw new Error("Invalid Gerrit project response.");
    const slash = path.lastIndexOf("/");
    return { host: this.host, hostname: this.hostname, name: path.slice(slash + 1), owner: slash < 0 ? "" : path.slice(0, slash), nameWithOwner: path,
      visibility: "public", sshUrl: "", httpsUrl: "", localPaths: [] };
  }
  async owners() { return []; }
  async searchRepos(): Promise<CloneRepository[]> { throw new Error("Gerrit repository search is not supported."); }
  async fork(): Promise<CloneRepository> { throw new Error("Gerrit forking is not supported."); }
  async cloneWithCli(): Promise<void> { throw new Error("Gerrit CLI cloning is not supported. Paste a clone URL."); }
  isAuthError(cause: unknown) { return cause instanceof GerritError && (cause.status === 401 || cause.status === 403); }
  isNotFoundError(cause: unknown) { return cause instanceof GerritError && cause.status === 404; }
  errorMessage() { return "Could not read this public Gerrit project."; }
}
