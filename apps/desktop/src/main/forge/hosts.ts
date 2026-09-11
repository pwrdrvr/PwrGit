import {
  classifyForgeHost,
  type ForgeHostConfig,
  type ForgeKind,
  type ForgeSettings,
  type ForgeValueSource
} from "@pwrgit/shared";
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
  /** Null when nothing can say which product runs here — the state that needs
   *  a human, and the only one the settings pane asks about. */
  kind: ForgeKind | null;
  kindSource: ForgeValueSource;
  enabled: boolean;
  enabledSource: ForgeValueSource;
};

export type ForgeHostsDeps = {
  /** Reads the persisted per-host config. A function rather than a value so a
   *  settings write is picked up without re-constructing the service. */
  readSettings: () => ForgeSettings;
  /** Whether that forge's CLI holds a credential for this exact host. Drives
   *  the derived `enabled` default, so "on" means "we can actually read it". */
  isSignedIn: (kind: ForgeKind, host: string) => boolean;
  env?: NodeJS.ProcessEnv;
};

function canonical(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
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
  private readonly isSignedIn: (kind: ForgeKind, host: string) => boolean;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: ForgeHostsDeps) {
    this.readSettings = deps.readSettings;
    this.isSignedIn = deps.isSignedIn;
    this.env = deps.env ?? process.env;
  }

  private configFor(host: string): ForgeHostConfig | undefined {
    return this.readSettings().hosts[canonical(host)];
  }

  /**
   * Which product runs at this host.
   *
   * An env allowlist wins, then an explicit config choice, then the hostname
   * heuristic (`github.com`, `gitlab.com`, `gitlab.*`). Null is a real answer
   * and must not collapse to a guess: sending a private repository's metadata
   * at the wrong forge's API is worse than reporting no status at all.
   */
  kindFor(host: string): { kind: ForgeKind | null; source: ForgeValueSource } {
    const key = canonical(host);
    const github = envHosts(this.env, GITHUB_HOSTS_ENV);
    if (github?.has(key) === true) return { kind: "github", source: "env" };
    const gitlab = envHosts(this.env, GITLAB_HOSTS_ENV);
    if (gitlab?.has(key) === true) return { kind: "gitlab", source: "env" };

    const configured = this.configFor(key)?.kind;
    if (configured !== undefined) return { kind: configured, source: "config" };

    const classified = classifyForgeHost(key);
    return {
      kind: classified === "other" ? null : classified,
      source: "auto"
    };
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
    // An unclassified host has no transport to enable. Reporting it "off"
    // would be the wrong word — nobody turned it off — but every caller of
    // this asks in order to decide whether to spawn something, and the answer
    // there is no. The settings pane reads `kind === null` for the distinction.
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
    return { enabled: this.isSignedIn(kind, key), source: "auto" };
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
    const github = envHosts(this.env, GITHUB_HOSTS_ENV);
    if (github !== null) for (const host of github) map[host] = "github";
    const gitlab = envHosts(this.env, GITLAB_HOSTS_ENV);
    if (gitlab !== null) for (const host of gitlab) map[host] = "gitlab";
    for (const [host, config] of Object.entries(this.readSettings().hosts)) {
      if (config.kind !== undefined) map[canonical(host)] = config.kind;
    }
    return map;
  }
}
