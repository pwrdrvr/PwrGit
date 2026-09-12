import {
  FORGE_KINDS,
  FORGE_PRODUCTS,
  forgeAllHostsOff,
  forgeCapabilities,
  forgeProduct,
  type ForgeHostStatus,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import { runGh } from "../github/gh-cli";
import { getGitHubToken } from "../github/pr-client";
import { mapLimit } from "../util/map-limit";
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
   *
   * `undefined` means "whatever host the CLI itself considers default", which is
   * NOT the same question as the SaaS hostname: `GH_HOST` / `GITLAB_HOST` move
   * that default, and naming a host overrides them. It is what an `assumed`
   * target asks — see `ForgeProbeTarget.assumed`.
   */
  loggedIn(host: string | undefined): Promise<boolean>;
};

/** One host to probe, and whether the user's switch allows it. Named for the
 *  probe, not for the report: `ForgeHostStatus` (shared) is what comes back. */
export type ForgeProbeTarget = {
  kind: ForgeKind;
  host: string;
  enabled: boolean;
  /**
   * Nothing names this host — it is here because resolution knows it
   * unconditionally. Two consequences, both load-bearing:
   *
   * - It is probed WITHOUT naming a host, so `GH_HOST`/`GITLAB_HOST` still
   *   decide. `pr-client.ts` spells out why: passing `--hostname github.com`
   *   overrides an operator's `GH_HOST` and flips a working Enterprise machine
   *   to "Signed out".
   * - It is NOT reported in `ForgeStatus.hosts`, because the settings pane has
   *   no row for it. Naming a host the user cannot see or switch is the
   *   two-sections-disagree bug from the other direction, and it would also make
   *   the pane's "Off" state unreachable by never letting `every` clear.
   *
   * It still counts toward the summary `loggedIn` — a credential is a credential.
   */
  assumed?: boolean;
};

export function cliFor(kind: ForgeKind): string {
  return forgeProduct(kind).cli;
}

/**
 * How each forge answers "installed?" and "signed in?".
 *
 * Keyed by kind rather than listed: an array is the shape that loses a product
 * in silence — a third forge simply never gets probed, and the settings pane
 * reports nothing about a CLI that is sitting right there. As a record, `tsc`
 * asks for the entry.
 */
const DEFAULT_PROBES: Readonly<Record<ForgeKind, ForgeProbe>> = {
  github: {
    kind: "github",
    cli: FORGE_PRODUCTS.github.cli,
    installed: async () => {
      await runGh(["--version"]);
      return true;
    },
    loggedIn: async (host) => (await getGitHubToken(host)) !== null
  },
  gitlab: {
    kind: "gitlab",
    cli: FORGE_PRODUCTS.gitlab.cli,
    installed: async () => {
      await runGlab(["--version"]);
      return true;
    },
    // `glab config get token` has no "default host" form, so an assumed target
    // asks about the host `GITLAB_HOST` names, which is what `getGitLabToken`
    // scopes `GITLAB_TOKEN` to.
    loggedIn: async (host) =>
      (await getGitLabToken(host ?? glabDefaultHost())) !== null
  }
};

function glabDefaultHost(): string {
  const host = process.env["GITLAB_HOST"]?.trim().toLowerCase();
  return host === undefined || host === "" ? FORGE_PRODUCTS.gitlab.saasHost : host;
}

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
  hosts?: () => readonly ForgeProbeTarget[];
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
};

/** Both SaaS hosts, on — what host resolution knows before any CLI has been
 *  enumerated, and so the honest default for a caller that injects nothing. */
function saasHosts(): ForgeProbeTarget[] {
  return FORGE_KINDS.map((kind) => ({
    kind,
    host: forgeProduct(kind).saasHost,
    enabled: true,
    assumed: true
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
 * on a machine signed in to a self-managed GitLab. Clone and fork read the
 * per-host answer through `forgeBlockAt(status, hostname)`, so the target set
 * must cover every host resolution can place — `ForgeHosts.statusTargets()`
 * derives it from `overrides()` for that reason. A host that resolves but was
 * never probed falls back to the forge-wide summary, which is the permissive
 * answer and was reported as "signed out" for env-allowlisted hosts.
 */
export class ForgeStatusService {
  private readonly probes: ForgeProbe[];
  private readonly hosts: () => readonly ForgeProbeTarget[];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private cached: { statuses: ForgeStatus[]; at: number; healthy: boolean } | null =
    null;
  private inFlight: Promise<ForgeStatus[]> | null = null;
  /** Bumped by every forced read; a pass whose epoch is stale may not publish. */
  private epoch = 0;
  /**
   * The last value listeners were given, kept separately from the read cache.
   *
   * A forced read retires `cached` so nobody is served a pre-action answer — but
   * that must not also erase what the renderer is currently painting, or every
   * forced read compares against nothing, reports "changed", and wakes the pane
   * to repaint the identical value.
   */
  private published: ForgeStatus[] | null = null;
  private readonly listeners = new Set<(statuses: ForgeStatus[]) => void>();

  constructor(deps: ForgeStatusServiceDeps = {}) {
    this.probes = deps.probes ?? FORGE_KINDS.map((kind) => DEFAULT_PROBES[kind]);
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

  async list(opts: { force?: boolean } = {}): Promise<ForgeStatus[]> {
    if (opts.force === true) {
      // A forced read exists to observe something the caller just did — signing
      // in, installing a CLI, flipping a host switch. Everything already running
      // or cached answers a question that has since changed, so retire it FIRST
      // and synchronously, before the await below yields.
      //
      // Bumping the epoch rather than only clearing the cache is what makes that
      // stick. A pass already in flight still runs to completion; without the
      // epoch it would write its pre-action answer into the freshly-emptied
      // cache and — because an empty cache compares as "changed" — broadcast it,
      // so the pane painted the pre-switch state before the forced pass landed.
      // A concurrent unforced read would adopt that same pass and act on it.
      this.epoch += 1;
      this.cached = null;
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
    const epoch = this.epoch;
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
    // Answered a question that has since changed: hand the result to whoever
    // awaited this pass, but do not cache it and do not wake the renderer with
    // it. The forced read that retired this epoch is already running.
    if (epoch !== this.epoch) return statuses;
    // A forge nobody can read is worth re-checking soon: the user is probably
    // fixing it in a terminal right now. A forge whose every host is switched
    // OFF is not broken, it is configured — classing that as a failure put the
    // cache on the 60-second retry, so an all-off machine with this pane open
    // re-spawned both CLIs about once a minute, forever.
    const healthy =
      statuses.some((status) => status.loggedIn) ||
      (statuses.length > 0 && statuses.every((status) => forgeAllHostsOff(status)));
    const changed =
      this.published === null || !sameStatuses(this.published, statuses);
    this.cached = { statuses, at: this.now(), healthy };
    this.published = statuses;
    if (changed) {
      for (const listener of this.listeners) listener(statuses);
    }
    return statuses;
  }
}

/**
 * Concurrent per-host credential reads.
 *
 * Each one is a `gh`/`glab` spawn, and the host list is user-grown — ten
 * hand-added instances would otherwise be ten simultaneous Go binaries
 * (~30-60MB RSS each) started by a settings pane repaint. `forge/AGENTS.md`
 * records the same class of incident on the clone catalog.
 */
const HOST_PROBE_CONCURRENCY = 4;

async function probeOne(
  probe: ForgeProbe,
  hosts: readonly ForgeProbeTarget[]
): Promise<ForgeStatus> {
  const base = {
    kind: probe.kind,
    cli: probe.cli,
    capabilities: forgeCapabilities(probe.kind)
  };
  let installed = false;
  try {
    installed = await probe.installed();
  } catch {
    // A missing binary is an ordinary state, not an error to surface.
    installed = false;
  }
  if (!installed) {
    // No CLI, nothing probed: listing hosts here would invite the reader to fix
    // a sign-in when the binary is what is missing.
    return { ...base, installed: false, loggedIn: false, hosts: [] };
  }

  const probed: Array<ForgeHostStatus & { assumed: boolean }> = new Array(
    hosts.length
  );
  await mapLimit(
    hosts.map((entry, index) => ({ entry, index })),
    HOST_PROBE_CONCURRENCY,
    async ({ entry, index }) => {
      probed[index] = {
        host: entry.host,
        enabled: entry.enabled,
        assumed: entry.assumed === true,
        // A disabled host is not asked. Probing it anyway would spawn the CLI
        // the switch exists to prevent, and the result would be unusable either
        // way.
        loggedIn:
          entry.enabled &&
          (await loggedInAt(probe, entry.assumed === true ? undefined : entry.host))
      };
    }
  );
  return {
    ...base,
    installed: true,
    // The summary counts an assumed host: a credential found through the CLI's
    // own default host is still a credential this forge can be read with.
    loggedIn: probed.some((entry) => entry.loggedIn),
    // The report does not. See `ForgeProbeTarget.assumed` — the pane has no row
    // for it, so naming it would put a host on screen the user cannot switch.
    hosts: probed
      .filter((entry) => !entry.assumed)
      .map(({ host, enabled, loggedIn }) => ({ host, enabled, loggedIn }))
  };
}

async function loggedInAt(
  probe: ForgeProbe,
  host: string | undefined
): Promise<boolean> {
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
