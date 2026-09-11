import type { ForgeKind } from "@pwrgit/shared";
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

function canonical(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
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
      current = canonical(hostMatch[1]);
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
  const gh = runners.gh ?? runGh;
  const glabAuthStatus = runners.glabAuthStatus ?? readGlabAuthStatus;
  const [github, gitlab] = await Promise.all([
    gh(["auth", "status", "--json", "hosts"])
      .then(parseGhHosts)
      .catch(() => [] as DiscoveredForgeHost[]),
    glabAuthStatus()
      .then(parseGlabHosts)
      .catch(() => [] as DiscoveredForgeHost[])
  ]);
  return [...github, ...gitlab];
}
