import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { artifactsTokenExpiry, parseArtifactsRemote, type ArtifactsAccountStatus, type CloneRepository } from "@pwrgit/shared";
import { createCliClient, type CliRunOptions } from "../cli-runner";

export function wranglerInvocation(env: NodeJS.ProcessEnv, platform = process.platform, exists: (path: string) => boolean = existsSync) {
  if (platform !== "win32") return { binary: "wrangler", prefix: [] };
  // npm's Windows .cmd shim cannot be spawned without a shell. Run the
  // installed package's JS entry with Node, keeping every argument separate.
  for (const directory of (env.PATH ?? env.Path ?? "").split(";")) {
    if (!win32.isAbsolute(directory)) continue;
    const script = win32.join(directory, "node_modules", "wrangler", "bin", "wrangler.js");
    if (exists(script)) return { binary: "node", prefix: [script] };
  }
  throw new Error("Install Wrangler with npm install -g wrangler, then restart PwrGit.");
}

export const wranglerClient = createCliClient({
  binary: "wrangler", label: "Cloudflare Wrangler", errorName: "WranglerError",
  invocation: wranglerInvocation,
  authenticationRequiredMessage: "Run wrangler login in a terminal, then re-check Cloudflare Artifacts in Settings.",
  nonInteractiveEnv: { CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_SANITIZE: "true", WRANGLER_LOG: "error" },
  sensitiveEnvNames: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY"],
  tokenPrefixes: ["art_v1_"],
  redactionPatterns: [
    { pattern: /art_v1_[A-Za-z0-9_?=&.-]+/g, replacement: "[REDACTED]" },
    { pattern: /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, replacement: "$1[REDACTED]" },
    { pattern: /("(?:apiToken|oauth_token|access_token|refresh_token|token|plaintext)"\s*:\s*")[^"]*/gi, replacement: "$1[REDACTED]" }
  ],
  authenticationHints: [/not authenticated|wrangler login|authentication error/i]
});
export type WranglerRunner = (args: string[], options?: CliRunOptions) => Promise<string>;

export const runWrangler: WranglerRunner = async (args, options) => {
  // Never load a checkout's wrangler.toml, .env, or .dev.vars. Authentication
  // remains owned by Wrangler; PwrGit never opens its credential/config files.
  const cwd = await mkdtemp(join(tmpdir(), "pwrgit-wrangler-"));
  try { return await wranglerClient.run(args, { timeoutMs: 60_000, ...options, cwd }); }
  finally { await rm(cwd, { recursive: true, force: true }); }
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Wrangler returned an unsupported Artifacts response. Update Wrangler and re-check.");
  return value as Record<string, unknown>;
}
function json(stdout: string): unknown {
  try { return JSON.parse(stdout) as unknown; }
  catch { throw new Error("Wrangler returned invalid JSON. Update Wrangler and re-check."); }
}
export function artifactsAccountId(hostname: string): string {
  const match = /^([a-f0-9]{32})\.artifacts\.cloudflare\.net$/.exec(hostname);
  if (!match?.[1]) throw new Error("Select a registered Cloudflare account.");
  return match[1];
}
function validNamespace(namespace: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/.test(namespace)) throw new Error("Choose a valid Artifacts namespace.");
}

/** JSON shapes verified against Cloudflare workers-sdk fcf625da and its CLI
 * output assertions; see fixtures/wrangler.json and docs/cloudflare-artifacts.md. */
export class ArtifactsWrangler {
  private cached: { at: number; value: ArtifactsAccountStatus } | undefined;
  private pending: Promise<ArtifactsAccountStatus> | undefined;
  constructor(private readonly run: WranglerRunner = runWrangler, private readonly now = Date.now) {}

  async accounts(force = false): Promise<ArtifactsAccountStatus> {
    if (force) { if (this.pending) await this.pending; this.cached = undefined; }
    if (this.cached && this.now() - this.cached.at < (this.cached.value.loggedIn ? 300_000 : 60_000)) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.probe().then((value) => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async probe(): Promise<ArtifactsAccountStatus> {
    try { await this.run(["--version"]); }
    catch { return { installed: false, loggedIn: false, accounts: [] }; }
    try {
      // whoami's ordinary text mode can exit zero when signed out. JSON mode
      // exits nonzero then. Discard everything except validated account metadata,
      // including raw credential fields emitted by older Wrangler releases.
      const payload = object(json(await this.run(["whoami", "--json"])));
      if (payload.loggedIn !== true || !Array.isArray(payload.accounts)) throw new Error("Run wrangler login, then re-check.");
      const accounts = payload.accounts.map((entry) => {
        const account = object(entry);
        if (typeof account.id !== "string" || !/^[a-f0-9]{32}$/i.test(account.id) || typeof account.name !== "string") throw new Error("Wrangler returned an invalid account list.");
        return { hostname: `${account.id.toLowerCase()}.artifacts.cloudflare.net`, name: account.name };
      });
      return { installed: true, loggedIn: true, accounts };
    } catch { return { installed: true, loggedIn: false, accounts: [] }; }
  }
  async hasAccount(hostname: string | undefined): Promise<boolean> {
    const status = await this.accounts();
    return status.loggedIn && status.accounts.some((account) => hostname === undefined || account.hostname === hostname);
  }
  private async command(hostname: string, args: string[]): Promise<unknown> {
    const account = artifactsAccountId(hostname);
    // Explicit account selection overrides both aliases. No caller can redirect
    // a token request to an account inferred from the checkout's config.
    return json(await this.run(["artifacts", ...args, "--json"], { env: { CLOUDFLARE_ACCOUNT_ID: account, CF_ACCOUNT_ID: account } }));
  }
  async namespaces(hostname: string): Promise<string[]> {
    const rows = await this.command(hostname, ["namespaces", "list"]);
    if (!Array.isArray(rows)) throw new Error("Wrangler returned no namespace list.");
    return rows.map((row) => { const name = object(row).namespace; if (typeof name !== "string") throw new Error("Wrangler returned an invalid namespace."); validNamespace(name); return name; });
  }
  private repository(value: unknown, hostname: string, namespace: string): CloneRepository {
    const row = object(value);
    const remote = typeof row.remote === "string" ? parseArtifactsRemote(row.remote) : null;
    if (remote === null || remote.hostname !== hostname || remote.namespace !== namespace || row.name !== remote.repo) throw new Error("Wrangler returned a repository remote that does not match the selected account and namespace.");
    return {
      name: remote.repo, owner: namespace, nameWithOwner: `${namespace}/${remote.repo}`,
      host: "artifacts", hostname, visibility: "unknown", sshUrl: "", httpsUrl: remote.remote, localPaths: [],
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.updated_at === "string" ? { updatedAt: row.updated_at } : {}),
      // A writable repo is not proof this credential may push.
      ...(row.read_only === true ? { viewerCanPush: false } : {})
    };
  }
  async repositories(hostname: string, namespace: string): Promise<CloneRepository[]> {
    validNamespace(namespace);
    const rows = await this.command(hostname, ["repos", "list", "--namespace", namespace]);
    if (!Array.isArray(rows)) throw new Error("Wrangler returned no repository list.");
    return rows.map((row) => this.repository(row, hostname, namespace));
  }
  async repositoryAt(remoteUrl: string): Promise<CloneRepository> {
    const remote = parseArtifactsRemote(remoteUrl);
    if (remote === null) throw new Error("Choose an exact Artifacts HTTPS remote.");
    const repository = this.repository(await this.command(remote.hostname, ["repos", "get", remote.repo, "--namespace", remote.namespace]), remote.hostname, remote.namespace);
    if (repository.httpsUrl !== remote.remote) throw new Error("Wrangler returned a different repository than requested.");
    return repository;
  }
  async createRepository(hostname: string, namespace: string, name: string): Promise<CloneRepository> {
    validNamespace(namespace);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error("Enter a valid repository name.");
    // Only an explicit UI submission calls this. The returned create token is
    // discarded here; Git obtains a fresh scoped token for its own operation.
    const result = await this.command(hostname, ["repos", "create", name, "--namespace", namespace, "--default-branch", "main"]);
    const repository = this.repository(result, hostname, namespace);
    if (repository.name !== name) throw new Error("Wrangler returned a different repository than requested.");
    return repository;
  }
  async token(remoteUrl: string, scope: "read" | "write"): Promise<string> {
    const remote = parseArtifactsRemote(remoteUrl);
    if (remote === null) throw new Error("Choose an exact Artifacts HTTPS remote.");
    const result = object(await this.command(remote.hostname, ["repos", "issue-token", remote.repo, "--namespace", remote.namespace, "--scope", scope, "--ttl", "3600"]));
    if (typeof result.plaintext !== "string" || result.scope !== scope || (artifactsTokenExpiry(result.plaintext) ?? 0) <= this.now()) throw new Error("Wrangler returned an invalid or expired repository token.");
    return result.plaintext;
  }
}
export const artifactsWrangler = new ArtifactsWrangler();
