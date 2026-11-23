import { canonicalForgeHostname, sanitizeForgeHostAccount } from "@pwrgit/shared";
import { CliError, type CliRunOptions } from "../forge/cli-runner";
import { GITHUB_DOT_COM, githubEnvToken } from "./gh-env-token";

/**
 * Which GitHub account a host is read as, and the credential that follows.
 *
 * `gh` holds several accounts per host. Without a choice PwrGit reads as
 * whichever one `gh auth switch` left active, and that stays the default. A
 * host can instead be pinned to one account (`ForgeHostConfig.account`), and
 * then three things must change together or one account's reads leak into
 * another's:
 *
 * - the token: `gh auth token --hostname H --user A`;
 * - the token cache, keyed by host AND account;
 * - every other `gh` spawn for H, which has no `--user` flag and so gets A's
 *   token through its environment (`GH_TOKEN` for github.com,
 *   `GH_ENTERPRISE_TOKEN` + `GH_HOST` for an Enterprise host).
 *
 * A pinned account that no longer resolves is "signed out" for that host.
 * Nothing falls back to the active account: reading as somebody the user
 * did not choose is the bug this exists to prevent.
 *
 * A token in the environment outranks a pin, as it outranks `gh`'s own
 * stored accounts (`githubEnvToken`). The pin is then simply not applied, and
 * Settings says so.
 *
 * Tokens stay inside this module and the spawned process's environment. The
 * names injected here are all in `GH_CLI_SPEC.sensitiveEnvNames`, so the
 * runner redacts their values from every diagnostic.
 */

export { GITHUB_DOT_COM, githubEnvToken };

const TOKEN_TTL_MS = 5 * 60_000;

/** Every variable through which `gh` takes a token from its environment. */
const ENV_TOKEN_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN"
] as const;

export type GhRawRunner = (args: string[], options?: CliRunOptions) => Promise<string>;

/** The account a host is pinned to, or undefined to follow gh's active one.
 *  Asked with a canonical hostname. */
export type GhAccountChooser = (host: string) => string | undefined;

function canonical(host: string | undefined): string {
  return host === undefined ? "" : (canonicalForgeHostname(host) ?? "");
}

/** github.com and GHE.com tenancies (`*.ghe.com`) take `GH_TOKEN`; every
 *  other host is Enterprise Server and takes `GH_ENTERPRISE_TOKEN`. That is
 *  `gh`'s own split. */
function takesGhToken(host: string): boolean {
  return host === GITHUB_DOT_COM || host.endsWith(".ghe.com");
}

/** The value of a `--repo`/`-R` argument names a host when it is a URL or
 *  `HOST/OWNER/REPO`; `OWNER/REPO` means gh's default host. */
function repoArgumentHost(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.includes("://")) {
    try {
      return new URL(value).hostname;
    } catch {
      return null;
    }
  }
  const segments = value.split("/");
  return segments.length >= 3 ? (segments[0] ?? null) : null;
}

/**
 * The host one `gh` invocation talks to, canonical.
 *
 * `--hostname` (the `api` family), then `--repo HOST/OWNER/REPO` (the MCP
 * server's `gh pr list`), then `GH_HOST` (how `targetHost` aims `gh repo …`),
 * then github.com. Flag parsing stops at `--`, after which everything belongs
 * to git.
 */
export function ghTargetHost(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "--hostname") return canonical(args[index + 1]);
    if (arg.startsWith("--hostname=")) return canonical(arg.slice("--hostname=".length));
    const repo =
      arg === "--repo" || arg === "-R"
        ? repoArgumentHost(args[index + 1])
        : arg.startsWith("--repo=")
          ? repoArgumentHost(arg.slice("--repo=".length))
          : null;
    if (repo !== null) return canonical(repo);
  }
  const fromEnv = canonical(env["GH_HOST"]);
  return fromEnv === "" ? GITHUB_DOT_COM : fromEnv;
}

/** `gh auth …` reads or writes the credential store itself and must see it
 *  untouched — injecting a token there would make `gh auth token` print the
 *  injected one back. `--version` talks to no host. */
function targetsAHost(args: readonly string[]): boolean {
  const verb = args[0];
  return verb !== undefined && verb !== "auth" && verb !== "version" && !verb.startsWith("-");
}

/** A pinned account that `gh` cannot hand a token for. Classified as an
 *  authentication failure, so every caller's existing "signed out" handling
 *  applies, and never retried with another account. */
export class GhAccountUnavailableError extends CliError {
  constructor(
    readonly host: string,
    readonly account: string
  ) {
    super(
      `${account} is not signed in to gh for ${host}. Run gh auth login --hostname ${host}, or choose another account in Settings → Forges.`,
      "authentication_required",
      "",
      "",
      "GhCliError"
    );
  }
}

export type GitHubCredentialsDeps = {
  /** Spawns `gh` as-is. Never this class's own `run`: `auth token` must not
   *  be given an injected token to print back. */
  run: GhRawRunner;
  /** The user's environment. A function so tests can vary it per case. */
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
  ttlMs?: number;
};

export class GitHubCredentials {
  private readonly cache = new Map<string, { token: string; at: number }>();
  private chooser: GhAccountChooser = () => undefined;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly deps: GitHubCredentialsDeps) {
    this.env = deps.env ?? (() => process.env);
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? TOKEN_TTL_MS;
  }

  /** Wired once at boot to `ForgeHosts.accountFor`. Passing null restores
   *  "always the active account" (tests). */
  setAccountChooser(chooser: GhAccountChooser | null): void {
    this.chooser = chooser ?? (() => undefined);
  }

  clear(): void {
    this.cache.clear();
  }

  /** The account a host is pinned to, sanitized; undefined follows gh's
   *  active account. */
  chosenAccount(host: string | undefined): string | undefined {
    const key = canonical(host);
    if (key === "") return undefined;
    return sanitizeForgeHostAccount(this.chooser(key)) ?? undefined;
  }

  /**
   * The token PwrGit reads `host` with, or null when there is none.
   *
   * Omitting `host` means "whatever host `gh` considers default", NOT
   * github.com — see `getGitHubToken`. No pin applies there.
   */
  async token(host?: string): Promise<string | null> {
    const key = host?.trim().toLowerCase() ?? "";
    const fromEnv = githubEnvToken(key, this.env());
    if (fromEnv !== null) return fromEnv.value;
    const account = key === "" ? undefined : this.chosenAccount(key);
    // Host AND account: one slot per host would hand the previous account's
    // token to the next one for the rest of the TTL.
    const cacheKey = `${key}\n${account ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) {
      return cached.token;
    }
    const args =
      key === ""
        ? ["auth", "token"]
        : [
            "auth",
            "token",
            "--hostname",
            key,
            ...(account === undefined ? [] : ["--user", account])
          ];
    try {
      const token = (
        account === undefined
          ? await this.deps.run(args)
          : // A pinned read asks gh for THAT account's stored token. An
            // environment token that did not apply above (an Enterprise token
            // for another GH_HOST) must not answer in its place.
            await this.deps.run(args, { env: withoutEnvTokens() })
      ).trim();
      if (token !== "") {
        this.cache.set(cacheKey, { token, at: this.now() });
        return token;
      }
    } catch {
      // gh missing, or no such account on this host. A pinned account is
      // never retried without `--user`: that would read as somebody else.
    }
    return null;
  }

  /**
   * The pin that applies to one `gh` spawn, decided synchronously: no pin, an
   * environment token in charge, or a command that talks to no host all
   * answer undefined, and the spawn then runs exactly as the caller wrote it.
   */
  private pinFor(
    args: readonly string[],
    overrides?: Readonly<Record<string, string | undefined>>
  ): { host: string; account: string } | undefined {
    if (!targetsAHost(args)) return undefined;
    const userEnv = this.env();
    const host = ghTargetHost(args, { ...userEnv, ...overrides });
    const account = this.chosenAccount(host);
    if (account === undefined) return undefined;
    if (githubEnvToken(host, userEnv) !== null) return undefined;
    return { host, account };
  }

  /**
   * Environment additions for one `gh` spawn, so it reads as the host's
   * pinned account. Undefined when nothing needs to change.
   *
   * Throws `GhAccountUnavailableError` when the pinned account has no token —
   * running the command anyway would read as gh's active account.
   */
  async spawnEnv(
    args: readonly string[],
    overrides?: Readonly<Record<string, string | undefined>>
  ): Promise<Record<string, string> | undefined> {
    const pin = this.pinFor(args, overrides);
    return pin === undefined ? undefined : await this.accountEnv(pin);
  }

  private async accountEnv(pin: {
    host: string;
    account: string;
  }): Promise<Record<string, string>> {
    const token = await this.token(pin.host);
    if (token === null) throw new GhAccountUnavailableError(pin.host, pin.account);
    return takesGhToken(pin.host)
      ? { GH_TOKEN: token }
      : { GH_ENTERPRISE_TOKEN: token, GH_HOST: pin.host };
  }

  /**
   * Run `gh` as the target host's pinned account.
   *
   * Without a pin this spawns in the same tick, with the caller's arguments
   * untouched: callers attach to the child's streams synchronously, and an
   * `await` in front of every spawn would change that for every command in
   * the app to serve the ones that are pinned.
   */
  run(args: string[], options?: CliRunOptions): Promise<string> {
    const pin = this.pinFor(args, options?.env);
    if (pin === undefined) {
      return options === undefined ? this.deps.run(args) : this.deps.run(args, options);
    }
    return this.accountEnv(pin).then((extra) =>
      this.deps.run(args, { ...options, env: { ...options?.env, ...extra } })
    );
  }
}

function withoutEnvTokens(): Record<string, undefined> {
  return Object.fromEntries(ENV_TOKEN_NAMES.map((name) => [name, undefined]));
}
