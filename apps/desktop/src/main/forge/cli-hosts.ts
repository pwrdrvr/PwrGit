import {
  canonicalForgeHostname,
  FORGE_KINDS,
  type ForgeKind
} from "@pwrgit/shared";
import { runGh } from "../github/gh-cli";
import { runGlab } from "./gitlab/glab-cli";

/**
 * One forge host a CLI has actually authenticated to.
 *
 * `kind` is not inferred here — it is whichever CLI answered. `gh` only knows
 * GitHub hosts and `glab` only knows GitLab ones, so enumeration carries the
 * product with it and nothing has to guess from the hostname.
 */
export type DiscoveredForgeHost = {
  kind: ForgeKind;
  /** Canonical lowercase hostname. */
  host: string;
  /** The signed-in account, when the CLI names one. */
  account?: string;
  /** GitHub only: `gh` reports token scopes, `glab` does not. */
  scopes?: string[];
};

/** The shared spelling, so a host enumerated here matches the key every
 *  lookup and every settings write uses. A second normalizer is how a host
 *  gets enumerated under a key nothing can resolve. */
function canonical(host: string): string {
  return canonicalForgeHostname(host) ?? "";
}

type GhAuthStatus = {
  hosts?: Record<
    string,
    Array<{ host?: unknown; login?: unknown; active?: unknown; scopes?: unknown }>
  >;
};

/**
 * Parse `gh auth status --json hosts`.
 *
 * The shape is host → accounts, because `gh` supports several accounts per
 * host. We take the active one, falling back to the first: PwrGit reads with
 * whichever credential `gh api --hostname` would use, and that is the active
 * account. Surfacing all of them would imply a choice PwrGit cannot make.
 */
export function parseGhHosts(json: string): DiscoveredForgeHost[] {
  let parsed: GhAuthStatus;
  try {
    parsed = JSON.parse(json) as GhAuthStatus;
  } catch {
    // A gh that does not support `--json hosts` prints usage text, not JSON.
    // That is an old gh, not an error worth surfacing — it just means no hosts
    // can be enumerated and the user adds them by hand.
    return [];
  }
  const hosts = parsed.hosts;
  if (hosts === null || typeof hosts !== "object") return [];

  const out: DiscoveredForgeHost[] = [];
  for (const [rawHost, accounts] of Object.entries(hosts)) {
    const host = canonical(rawHost);
    // Rejected by the shared validator (a port, a path, a malformed label):
    // enumerating it would create a row no lookup could ever match.
    if (host === "") continue;
    const list = Array.isArray(accounts) ? accounts : [];
    const chosen = list.find((entry) => entry?.active === true) ?? list[0];
    const login = typeof chosen?.login === "string" ? chosen.login : undefined;
    // `scopes` is one comma-separated string, not a list.
    const scopes =
      typeof chosen?.scopes === "string"
        ? chosen.scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter((scope) => scope !== "")
        : undefined;
    out.push({
      kind: "github",
      host,
      ...(login === undefined ? {} : { account: login }),
      ...(scopes === undefined || scopes.length === 0 ? {} : { scopes })
    });
  }
  return out;
}

/** A hostname line in `glab auth status` output: no indent, no decoration. */
const GLAB_HOST_LINE = /^([a-z0-9][a-z0-9.-]*\.[a-z0-9-]+)\s*$/i;
/** `  ✓ Logged in to gitlab.com as someone (keyring)` */
const GLAB_ACCOUNT_LINE = /Logged in to\s+\S+\s+as\s+(\S+)/i;

/**
 * Parse `glab auth status --all`.
 *
 * `glab` has no JSON output for this (1.117), so the text is the interface.
 * Only two things are read: a hostname at column zero, and the account on the
 * indented line beneath it. Everything else — protocols, endpoints, the
 * token line — is deliberately ignored, so a cosmetic change to those cannot
 * break enumeration.
 *
 * A host is reported only when a "Logged in" line follows it. `glab` lists
 * configured-but-failed instances too, and those are not hosts PwrGit can read.
 */
export function parseGlabHosts(text: string): DiscoveredForgeHost[] {
  const out: DiscoveredForgeHost[] = [];
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    // Strip ANSI colour. Written as \u001b rather than a literal ESC byte:
    // an invisible control character in source is unreadable in a diff and
    // easy to drop in a copy-paste, which would silently break every
    // coloured line.
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r$/, "");
    const hostMatch = GLAB_HOST_LINE.exec(line);
    if (hostMatch?.[1] !== undefined) {
      const canonicalHost = canonical(hostMatch[1]);
      current = canonicalHost === "" ? null : canonicalHost;
      continue;
    }
    if (current === null) continue;
    const account = GLAB_ACCOUNT_LINE.exec(line);
    if (account?.[1] !== undefined) {
      out.push({ kind: "gitlab", host: current, account: account[1] });
      current = null;
    }
  }
  return out;
}

export type ForgeCliRunners = {
  gh?: (args: string[]) => Promise<string>;
  /** Resolves glab's **stderr**, not its stdout — see `readGlabAuthStatus`. */
  glabAuthStatus?: () => Promise<string>;
};

/**
 * `glab auth status` writes its report to **stderr**, not stdout.
 *
 * `runGlab` resolves stdout, so reading this the obvious way returns an empty
 * string and enumerates nothing — silently, on a machine that is signed in.
 * The runner's `onStderr` hook is the supported way to see it.
 */
async function readGlabAuthStatus(): Promise<string> {
  let captured = "";
  try {
    await runGlab(["auth", "status", "--all"], {
      onStderr: (chunk) => {
        captured += chunk;
      }
    });
  } catch {
    // A non-zero exit still reports the hosts it did reach, and `glab` exits
    // non-zero whenever ANY configured instance fails to authenticate. Keeping
    // what stderr produced is the whole point of not rethrowing here.
  }
  return captured;
}

/**
 * Every forge host the two CLIs are signed in to.
 *
 * This — plus hosts the user adds by hand — is the ONLY source of forge hosts.
 * Git remotes deliberately are not: a remote is an ssh target, and a box on a
 * home network or a bare repo on a NAS is not a forge. Deriving rows from
 * remotes would fill this list with machines that will never be forges and ask
 * the user to classify each one.
 *
 * A CLI that is missing or signed out contributes nothing rather than failing:
 * enumeration is best-effort, exactly like every other forge read.
 */
export async function discoverForgeHosts(
  runners: ForgeCliRunners = {}
): Promise<DiscoveredForgeHost[]> {
  const found = await Promise.all(
    FORGE_KINDS.map((kind) =>
      HOST_ENUMERATORS[kind](runners).catch(() => [] as DiscoveredForgeHost[])
    )
  );
  return found.flat();
}

/**
 * How each product's CLI reports what it is signed in to.
 *
 * A record rather than two awaited calls in the function above: a hand-written
 * pair is the shape that loses a product in silence — its CLI is simply never
 * asked, and every host it knows about is missing from Settings with nothing
 * anywhere saying why. Each entry reads its own override off `ForgeCliRunners`
 * because the two CLIs answer differently enough that one signature would fit
 * neither (see `readGlabAuthStatus`).
 */
type ForgeHostEnumerator = (
  runners: ForgeCliRunners
) => Promise<DiscoveredForgeHost[]>;

const HOST_ENUMERATORS: Readonly<Record<ForgeKind, ForgeHostEnumerator>> = {
  github: async (runners) =>
    parseGhHosts(
      await (runners.gh ?? runGh)(["auth", "status", "--json", "hosts"])
    ),
  gitlab: async (runners) =>
    parseGlabHosts(await (runners.glabAuthStatus ?? readGlabAuthStatus)())
};

/** Enumeration spawns two subprocesses; a resolve must not. */
const DIRECTORY_TTL_MS = 5 * 60_000;

export type ForgeHostDirectoryDeps = {
  discover?: () => Promise<DiscoveredForgeHost[]>;
  now?: () => number;
  ttlMs?: number;
};

/**
 * The app's one cached answer to "which forge hosts are signed in".
 *
 * `ForgeHosts` is synchronous on purpose — `PrService` resolves a remote on
 * every refresh, long after startup, and an async gate there would either block
 * the refresh or race it. So the subprocess cost lives here instead: this is
 * primed once at boot and re-read from memory forever after, exactly the shape
 * `ForgeStatusService` uses for the same reason.
 *
 * `current()` never spawns and never throws. Before the first refresh lands it
 * answers empty, which degrades to "github.com and gitlab.com only" rather than
 * to an error — the two hosts `ForgeHosts.kindFor` knows without help.
 */
export class ForgeHostDirectory {
  private hosts: readonly DiscoveredForgeHost[] = [];
  private at = 0;
  private inFlight: Promise<readonly DiscoveredForgeHost[]> | null = null;
  private readonly discover: () => Promise<DiscoveredForgeHost[]>;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(deps: ForgeHostDirectoryDeps = {}) {
    this.discover = deps.discover ?? (async () => await discoverForgeHosts());
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? DIRECTORY_TTL_MS;
  }

  /** Last known hosts. Synchronous, cheap, and safe to call per resolve. */
  current(): readonly DiscoveredForgeHost[] {
    return this.hosts;
  }

  /**
   * Re-read both CLIs, coalescing concurrent callers onto one pass.
   *
   * A failed enumeration keeps the previous list rather than emptying it: a
   * transient spawn failure must not make every Enterprise host stop resolving
   * mid-session.
   */
  async refresh(opts: { force?: boolean } = {}): Promise<readonly DiscoveredForgeHost[]> {
    if (opts.force !== true && this.now() - this.at < this.ttlMs && this.at !== 0) {
      return this.hosts;
    }
    // A forced refresh exists to observe something the caller just did —
    // signing in from a terminal. Adopting a pass that STARTED before that
    // action answers with pre-action state, so wait it out and run a fresh
    // one. An ordinary refresh still coalesces.
    if (opts.force === true) {
      while (this.inFlight !== null) await this.inFlight;
    } else {
      const existing = this.inFlight;
      if (existing !== null) return await existing;
    }

    const running = this.discover()
      .then((hosts) => {
        this.hosts = hosts;
        this.at = this.now();
        return this.hosts;
      })
      .catch(() => this.hosts)
      .finally(() => {
        if (this.inFlight === running) this.inFlight = null;
      });
    this.inFlight = running;
    return await running;
  }
}
