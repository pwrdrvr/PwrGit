import {
  canonicalForgeHostname,
  type ForgeHostConfig,
  type ForgeKind,
  type ForgeSettings,
  type ForgeValueSource
} from "@pwrgit/shared";
import type { DiscoveredForgeHost } from "./cli-hosts";
import type { ForgeHostRow } from "@pwrgit/shared";
import type { ForgeHostOverrides } from "./resolve";

/** Env escape hatches, mirroring the `GITHUB_TOKEN`/`GITLAB_TOKEN` pattern
 *  already used by the two CLI clients. A comma-separated allowlist of hosts;
 *  anything absent from a set list is off. */
const GITHUB_HOSTS_ENV = "PWRGIT_GITHUB_HOSTS";
const GITLAB_HOSTS_ENV = "PWRGIT_GITLAB_HOSTS";

/** One host, after config, env and the hostname heuristic have been reconciled. */
export type ResolvedForgeHost = {
  /** Canonical lowercase hostname, as `parseRemoteUrl` produces it. */
  host: string;
  /** Null means "not a forge host PwrGit knows", which is the ordinary answer
   *  for any ssh remote. It is NOT a question for the user — see `kindFor`. */
  kind: ForgeKind | null;
  kindSource: ForgeValueSource;
  enabled: boolean;
  enabledSource: ForgeValueSource;
};

export type ForgeHostsDeps = {
  /** Reads the persisted per-host config. A function rather than a value so a
   *  settings write is picked up without re-constructing the service. */
  readSettings: () => ForgeSettings;
  /** Hosts the CLIs report being signed in to. The primary source of the host
   *  list, and what makes the derived `enabled` default mean "we can actually
   *  read this". Injected already-resolved — enumeration spawns two processes
   *  and is cached by the caller, not re-run per lookup. */
  discovered: () => readonly DiscoveredForgeHost[];
  env?: NodeJS.ProcessEnv;
};

/** A forge host, however PwrGit came to know about it. */
export type ForgeHostEntry = ResolvedForgeHost & {
  /** `cli` — the CLI is signed in here. `config` — the user added it by hand
   *  and no CLI reports it, which is the state that needs a sign-in prompt. */
  origin: "cli" | "config";
  account?: string;
  scopes?: string[];
};

/** Shared with the settings write path, so a stored key always matches a
 *  lookup. An unusable hostname collapses to "" and matches nothing. */
function canonical(host: string): string {
  return canonicalForgeHostname(host) ?? "";
}

/** Parse a comma-separated host allowlist. Returns null when unset, which is
 *  different from an empty list: unset means "env has no opinion". */
function envHosts(
  env: NodeJS.ProcessEnv,
  name: string
): ReadonlySet<string> | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return null;
  return new Set(
    raw
      .split(",")
      .map((entry) => canonical(entry))
      .filter((entry) => entry !== "")
  );
}

/**
 * The one place that answers "which forge runs at this host, and may we talk
 * to it".
 *
 * Both questions have the same three-layer shape — env, then explicit config,
 * then something derived — and both are read on the hot path (every PR refresh
 * resolves a remote) as well as by the settings pane. Keeping them together is
 * what stops the pane and the fetcher from disagreeing: a host the pane paints
 * as "off" must be a host no transport will spawn a CLI for, and that is only
 * true if both read this.
 *
 * Deliberately synchronous. `PrService` resolves a remote per refresh, long
 * after startup, and an async gate there would either block the refresh or race
 * it. Sign-in state is injected already-known (`ForgeStatusService` caches it
 * for the whole app) rather than probed here.
 */
export class ForgeHosts {
  private readonly readSettings: () => ForgeSettings;
  private readonly discovered: () => readonly DiscoveredForgeHost[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: ForgeHostsDeps) {
    this.readSettings = deps.readSettings;
    this.discovered = deps.discovered;
    this.env = deps.env ?? process.env;
  }

  /** Memoized on the array identity: `discovered()` returns the caller's
   *  cached list, so the map is rebuilt only when that list is replaced —
   *  `kindFor` sits on the per-refresh remote-resolution path and must not
   *  rescan for every question asked about a host. */
  private discoveredIndex:
    | { source: readonly DiscoveredForgeHost[]; byHost: Map<string, DiscoveredForgeHost> }
    | null = null;

  private discoveredFor(host: string): DiscoveredForgeHost | undefined {
    const source = this.discovered();
    if (this.discoveredIndex?.source !== source) {
      this.discoveredIndex = {
        source,
        byHost: new Map(source.map((entry) => [entry.host, entry]))
      };
    }
    return this.discoveredIndex.byHost.get(canonical(host));
  }

  private isSignedIn(host: string): boolean {
    return this.discoveredFor(host) !== undefined;
  }

  private configFor(host: string): ForgeHostConfig | undefined {
    return this.readSettings().hosts[canonical(host)];
  }

  /**
   * Which product runs at this host.
   *
   * Env allowlist, then an explicit config entry (a host the user added), then
   * what a CLI reported, then the two SaaS hostnames — so a fresh install with
   * `gh` signed in works before anyone opens Settings.
   *
   * Null means "not a forge host we know about", and that is the ordinary
   * answer for most remotes: a git remote is an ssh target, and a box on a home
   * network or a bare repo on a NAS is not a forge. Null is silent — no row, no
   * prompt, no feature — never a question put to the user. The hostname is
   * deliberately NOT used to guess beyond github.com/gitlab.com: `gitlab.*` was
   * dropped because a name is not evidence, and a wrong guess sends a private
   * repository's metadata at the wrong API.
   */
  kindFor(host: string): { kind: ForgeKind | null; source: ForgeValueSource } {
    const key = canonical(host);
    const github = envHosts(this.env, GITHUB_HOSTS_ENV);
    if (github?.has(key) === true) return { kind: "github", source: "env" };
    const gitlab = envHosts(this.env, GITLAB_HOSTS_ENV);
    if (gitlab?.has(key) === true) return { kind: "gitlab", source: "env" };

    const configured = this.configFor(key)?.kind;
    if (configured !== undefined) return { kind: configured, source: "config" };

    const found = this.discoveredFor(key);
    if (found !== undefined) return { kind: found.kind, source: "auto" };

    // The two SaaS hosts only. Everything else must be signed in to or added.
    if (key === "github.com") return { kind: "github", source: "auto" };
    if (key === "gitlab.com") return { kind: "gitlab", source: "auto" };
    return { kind: null, source: "auto" };
  }

  /**
   * Whether PwrGit may talk to this host at all.
   *
   * The default is DERIVED from sign-in rather than hardcoded to on, so a
   * machine that has never signed in to a forge does not report that forge as
   * broken — and so nobody who is already signed in loses anything on upgrade.
   * An explicit config value always wins, in both directions: a host turned off
   * by hand stays off after a later sign-in.
   */
  isEnabled(host: string): { enabled: boolean; source: ForgeValueSource } {
    const key = canonical(host);
    const { kind } = this.kindFor(key);
    // Not a forge we know: there is no transport to enable. Callers ask this
    // to decide whether to spawn something, and the answer is no. It is not
    // "off" in any sense the user would recognise, and no row is shown for it.
    if (kind === null) return { enabled: false, source: "auto" };

    const env =
      kind === "github"
        ? envHosts(this.env, GITHUB_HOSTS_ENV)
        : envHosts(this.env, GITLAB_HOSTS_ENV);
    // A set allowlist is exhaustive: a host it does not name is off, even if
    // config says otherwise. That is what makes it usable to scope a session.
    if (env !== null) return { enabled: env.has(key), source: "env" };

    const configured = this.configFor(key)?.enabled;
    if (configured !== undefined) {
      return { enabled: configured, source: "config" };
    }
    return { enabled: this.isSignedIn(key), source: "auto" };
  }

  /** Everything resolved, for one host. */
  resolve(host: string): ResolvedForgeHost {
    const key = canonical(host);
    const kind = this.kindFor(key);
    const enabled = this.isEnabled(key);
    return {
      host: key,
      kind: kind.kind,
      kindSource: kind.source,
      enabled: enabled.enabled,
      enabledSource: enabled.source
    };
  }

  /**
   * Every forge host PwrGit knows about, for the settings pane.
   *
   * Two sources, deliberately: what the CLIs are signed in to, and what the
   * user added by hand. Git remotes are NOT a source — see `kindFor`. A
   * config-only entry is a host somebody added that no CLI reports, which is
   * exactly the row that should offer a sign-in command.
   */
  list(): ForgeHostEntry[] {
    const entries = new Map<string, ForgeHostEntry>();
    for (const found of this.discovered()) {
      entries.set(found.host, {
        ...this.resolve(found.host),
        origin: "cli",
        ...(found.account === undefined ? {} : { account: found.account }),
        ...(found.scopes === undefined ? {} : { scopes: found.scopes })
      });
    }
    for (const host of Object.keys(this.readSettings().hosts)) {
      const key = canonical(host);
      if (entries.has(key)) continue;
      const resolved = this.resolve(key);
      // A config entry that only flipped a switch on a host no CLI reports
      // names no forge, so there is nothing to show a row for.
      if (resolved.kind === null) continue;
      entries.set(key, { ...resolved, origin: "config" });
    }
    return [...entries.values()].sort((a, b) => a.host.localeCompare(b.host));
  }

  /**
   * The explicit host→kind map `resolveForgeRepo` takes.
   *
   * Only hosts with a decision recorded appear — the heuristic already covers
   * the rest, and duplicating its answers here would mean two places to change
   * when it changes. A host whose kind is known but which is DISABLED is
   * deliberately still in the map: resolution and permission are separate
   * questions, and callers gate on `isEnabled` so that "off" and "unknown forge"
   * stay distinguishable rather than both arriving as a null resolution.
   */
  overrides(): ForgeHostOverrides {
    const map: Record<string, ForgeKind> = {};
    // Applied weakest-first, so the LAST writer wins and the result matches
    // `kindFor`'s env > config > discovered order exactly. Building this map
    // in the opposite order is how the resolver and the settings pane end up
    // routing the same host to two different providers.
    for (const found of this.discovered()) map[found.host] = found.kind;
    for (const [host, config] of Object.entries(this.readSettings().hosts)) {
      const key = canonical(host);
      if (key !== "" && config.kind !== undefined) map[key] = config.kind;
    }
    const github = envHosts(this.env, GITHUB_HOSTS_ENV);
    if (github !== null) for (const host of github) map[host] = "github";
    const gitlab = envHosts(this.env, GITLAB_HOSTS_ENV);
    if (gitlab !== null) for (const host of gitlab) map[host] = "gitlab";
    return map;
  }
}

/** The CLI each forge speaks through, for a row's remediation command. */
const CLI_FOR: Readonly<Record<ForgeKind, string>> = {
  github: "gh",
  gitlab: "glab"
};

/**
 * What Settings renders, and the refresh it can ask for.
 *
 * A thin façade over `ForgeHosts` plus the directory, so the IPC handler takes
 * one dependency instead of wiring both — and so the renderer never learns that
 * enumeration is two subprocesses behind a cache.
 */
export class ForgeHostsView {
  constructor(
    private readonly hosts: ForgeHosts,
    private readonly refreshDirectory: () => Promise<unknown>
  ) {}

  async refresh(): Promise<void> {
    await this.refreshDirectory();
  }

  rows(): ForgeHostRow[] {
    return this.hosts.list().flatMap((entry) =>
      entry.kind === null
        ? []
        : [
            {
              host: entry.host,
              kind: entry.kind,
              enabled: entry.enabled,
              enabledSource: entry.enabledSource,
              origin: entry.origin,
              cli: CLI_FOR[entry.kind],
              ...(entry.account === undefined ? {} : { account: entry.account }),
              ...(entry.scopes === undefined ? {} : { scopes: entry.scopes })
            }
          ]
    );
  }
}
