import {
  FORGE_SAAS_HOST,
  type ForgeHostStatus,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import { runGh } from "../github/gh-cli";
import { getGitHubToken } from "../github/pr-client";
import { capabilitiesFor } from "./capabilities";
import { getGitLabToken, runGlab } from "./gitlab/glab-cli";

/** Probing spawns a subprocess; a status read must not. */
const STATUS_TTL_MS = 5 * 60_000;
/** A missing CLI is the common case and should not be re-probed constantly. */
const FAILURE_TTL_MS = 60_000;

export type ForgeProbe = {
  kind: ForgeKind;
  cli: string;
  /** Resolves false when the binary is absent or unusable. */
  installed(): Promise<boolean>;
  /**
   * Whether this host holds a usable credential. Only consulted when installed,
   * and only for a host the user's switch allows — a disabled host must not
   * cause a spawn, which is the whole meaning of "off".
   */
  loggedIn(host: string): Promise<boolean>;
};

/** One host to probe, and whether the user's switch allows it. */
export type ForgeStatusHost = {
  kind: ForgeKind;
  host: string;
  enabled: boolean;
};

/** The binary each forge speaks through. One source: this value reaches the
 *  user as a command they are told to run, so a second copy that drifts would
 *  print a command naming a CLI the app never invokes. */
export const FORGE_CLI: Readonly<Record<ForgeKind, string>> = {
  github: "gh",
  gitlab: "glab"
};

export function cliFor(kind: ForgeKind): string {
  return FORGE_CLI[kind];
}

const DEFAULT_PROBES: ForgeProbe[] = [
  {
    kind: "github",
    cli: FORGE_CLI.github,
    installed: async () => {
      await runGh(["--version"]);
      return true;
    },
    loggedIn: async (host) => (await getGitHubToken(host)) !== null
  },
  {
    kind: "gitlab",
    cli: FORGE_CLI.gitlab,
    installed: async () => {
      await runGlab(["--version"]);
      return true;
    },
    loggedIn: async (host) => (await getGitLabToken(host)) !== null
  }
];

export type ForgeStatusServiceDeps = {
  probes?: ForgeProbe[];
  /**
   * Which forge hosts to probe, and whether the user's switch allows each one.
   *
   * Injected already-resolved rather than enumerated here: enumeration is two
   * subprocesses that `ForgeHostDirectory` already caches for the whole app, and
   * permission is `ForgeHosts.isEnabled`'s single answer. Reading both through
   * one function is what keeps this service's report and the transport's
   * behaviour the same answer rather than two derivations of it.
   *
   * **The caller owns completeness.** This service probes what it is given and
   * nothing else — `ForgeHosts.statusTargets()` is what guarantees each forge's
   * SaaS host is in the list even when no CLI reports it, and that guarantee
   * lives there because only `ForgeHosts` can say whether the user turned it off.
   *
   * Omitted by tests and the E2E fixture, which get the two SaaS hosts.
   */
  hosts?: () => readonly ForgeStatusHost[];
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
};

/** Both SaaS hosts, on — what host resolution knows before any CLI has been
 *  enumerated, and so the honest default for a caller that injects nothing. */
function saasHosts(): ForgeStatusHost[] {
  return (Object.keys(FORGE_SAAS_HOST) as ForgeKind[]).map((kind) => ({
    kind,
    host: FORGE_SAAS_HOST[kind],
    enabled: true
  }));
}

/**
 * Cached, main-owned answer to "which forges work right now".
 *
 * Every probe costs a subprocess, so this exists to make the renderer's
 * question free. Under React StrictMode each effect runs twice and a naive
 * renderer-side probe would double every spawn on every mount; here repeated
 * asks collapse onto one cached value and one in-flight promise.
 *
 * The answer is per host, then summarized per forge. Probing one hardcoded
 * endpoint per forge is what made Settings → Forges report "GitLab: Signed out"
 * on a machine signed in to a self-managed GitLab — and made the fork dialog
 * refuse to fork there for the same reason.
 */
export class ForgeStatusService {
  private readonly probes: ForgeProbe[];
  private readonly hosts: () => readonly ForgeStatusHost[];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private cached: { statuses: ForgeStatus[]; at: number; healthy: boolean } | null =
    null;
  private inFlight: Promise<ForgeStatus[]> | null = null;
  private readonly listeners = new Set<(statuses: ForgeStatus[]) => void>();

  constructor(deps: ForgeStatusServiceDeps = {}) {
    this.probes = deps.probes ?? DEFAULT_PROBES;
    this.hosts = deps.hosts ?? saasHosts;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? STATUS_TTL_MS;
    this.failureTtlMs = deps.failureTtlMs ?? FAILURE_TTL_MS;
  }

  /** Subscribe to changes; returns an unsubscribe. */
  onChange(listener: (statuses: ForgeStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Drop the cached answer.
   *
   * The host set and its switches are *inputs* to the answer, not just things
   * the answer is about, so a value computed under the old ones is wrong the
   * moment the user flips a switch — and the TTL would go on serving it for up
   * to five minutes. Callers that just changed those inputs invalidate and then
   * force a read, so the change is observed rather than waited out.
   */
  invalidate(): void {
    this.cached = null;
  }

  async list(opts: { force?: boolean } = {}): Promise<ForgeStatus[]> {
    if (opts.force === true) {
      // A forced read exists to observe something the caller just did — signing
      // in, installing a CLI. Adopting a probe that STARTED before that action
      // would answer with pre-action state, so wait it out and run a fresh one.
      while (this.inFlight !== null) await this.inFlight;
    } else {
      const now = this.now();
      if (this.cached !== null) {
        const ttl = this.cached.healthy ? this.ttlMs : this.failureTtlMs;
        if (now - this.cached.at < ttl) return this.cached.statuses;
      }
      // Coalesce: several surfaces mount at once and all want this immediately.
      const existing = this.inFlight;
      if (existing !== null) return await existing;
    }

    const probing = this.probeAll().finally(() => {
      if (this.inFlight === probing) this.inFlight = null;
    });
    this.inFlight = probing;
    return await probing;
  }

  private async probeAll(): Promise<ForgeStatus[]> {
    // One read of the host list for the whole pass: it is a resolved snapshot,
    // and re-reading it per probe could straddle a settings write and report two
    // forges against two different sets of switches.
    const hosts = this.hosts();
    const statuses = await Promise.all(
      this.probes.map(
        async (probe) =>
          await probeOne(
            probe,
            hosts.filter((entry) => entry.kind === probe.kind)
          )
      )
    );
    const healthy = statuses.some((status) => status.loggedIn);
    const changed =
      this.cached === null || !sameStatuses(this.cached.statuses, statuses);
    this.cached = { statuses, at: this.now(), healthy };
    if (changed) {
      for (const listener of this.listeners) listener(statuses);
    }
    return statuses;
  }
}

async function probeOne(
  probe: ForgeProbe,
  hosts: readonly ForgeStatusHost[]
): Promise<ForgeStatus> {
  const capabilities = capabilitiesFor(probe.kind);
  const unavailable: ForgeStatus = {
    kind: probe.kind,
    cli: probe.cli,
    installed: false,
    loggedIn: false,
    capabilities,
    // No CLI, nothing probed: listing hosts here would invite the reader to fix
    // a sign-in when the binary is what is missing.
    hosts: []
  };
  let installed = false;
  try {
    installed = await probe.installed();
  } catch {
    // A missing binary is an ordinary state, not an error to surface.
    return unavailable;
  }
  if (!installed) return unavailable;

  const probed: ForgeHostStatus[] = await Promise.all(
    hosts.map(async (entry) => ({
      host: entry.host,
      enabled: entry.enabled,
      // A disabled host is not asked. Probing it anyway would spawn the CLI the
      // switch exists to prevent, and the result would be unusable either way.
      loggedIn: entry.enabled && (await loggedInAt(probe, entry.host))
    }))
  );
  return {
    kind: probe.kind,
    cli: probe.cli,
    installed,
    loggedIn: probed.some((entry) => entry.loggedIn),
    capabilities,
    hosts: probed
  };
}

async function loggedInAt(probe: ForgeProbe, host: string): Promise<boolean> {
  try {
    return await probe.loggedIn(host);
  } catch {
    // An unreachable or unconfigured host is "no credential here", not an error
    // worth failing the other hosts of the same forge over.
    return false;
  }
}

function sameStatuses(left: ForgeStatus[], right: ForgeStatus[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((status, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      status.kind === other.kind &&
      status.installed === other.installed &&
      status.loggedIn === other.loggedIn &&
      // Per-host state is rendered, so it has to wake listeners too. Two enabled
      // hosts where one is switched off leaves the summary `loggedIn` alone, and
      // comparing only the summary would leave the pane painting the old list.
      sameHosts(status.hosts, other.hosts)
    );
  });
}

function sameHosts(left: ForgeHostStatus[], right: ForgeHostStatus[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.host === other.host &&
      entry.enabled === other.enabled &&
      entry.loggedIn === other.loggedIn
    );
  });
}
