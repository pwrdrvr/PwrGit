import type { ForgeKind, ForgeStatus } from "@pwrgit/shared";
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
  /** Only consulted when installed; resolves false when logged out. */
  loggedIn(): Promise<boolean>;
};

const DEFAULT_PROBES: ForgeProbe[] = [
  {
    kind: "github",
    cli: "gh",
    installed: async () => {
      await runGh(["--version"]);
      return true;
    },
    loggedIn: async () => (await getGitHubToken()) !== null
  },
  {
    kind: "gitlab",
    cli: "glab",
    installed: async () => {
      await runGlab(["--version"]);
      return true;
    },
    // gitlab.com is the only host we can probe without a repo in hand; a
    // self-managed instance proves itself when its repo is actually queried.
    loggedIn: async () => (await getGitLabToken("gitlab.com")) !== null
  }
];

export type ForgeStatusServiceDeps = {
  probes?: ForgeProbe[];
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
};

/**
 * Cached, main-owned answer to "which forges work right now".
 *
 * Every probe costs a subprocess, so this exists to make the renderer's
 * question free. Under React StrictMode each effect runs twice and a naive
 * renderer-side probe would double every spawn on every mount; here repeated
 * asks collapse onto one cached value and one in-flight promise.
 */
export class ForgeStatusService {
  private readonly probes: ForgeProbe[];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private cached: { statuses: ForgeStatus[]; at: number; healthy: boolean } | null =
    null;
  private inFlight: Promise<ForgeStatus[]> | null = null;
  private readonly listeners = new Set<(statuses: ForgeStatus[]) => void>();

  constructor(deps: ForgeStatusServiceDeps = {}) {
    this.probes = deps.probes ?? DEFAULT_PROBES;
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
    const statuses = await Promise.all(
      this.probes.map(async (probe) => await probeOne(probe))
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

async function probeOne(probe: ForgeProbe): Promise<ForgeStatus> {
  const capabilities = capabilitiesFor(probe.kind);
  const unavailable: ForgeStatus = {
    kind: probe.kind,
    cli: probe.cli,
    installed: false,
    loggedIn: false,
    capabilities
  };
  let installed = false;
  try {
    installed = await probe.installed();
  } catch {
    // A missing binary is an ordinary state, not an error to surface.
    return unavailable;
  }
  if (!installed) return unavailable;

  let loggedIn = false;
  try {
    loggedIn = await probe.loggedIn();
  } catch {
    loggedIn = false;
  }
  return { kind: probe.kind, cli: probe.cli, installed, loggedIn, capabilities };
}

function sameStatuses(left: ForgeStatus[], right: ForgeStatus[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((status, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      status.kind === other.kind &&
      status.installed === other.installed &&
      status.loggedIn === other.loggedIn
    );
  });
}
