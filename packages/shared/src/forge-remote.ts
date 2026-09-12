import {
  FORGE_PRODUCTS,
  forgeAllowsPathDepth,
  forgeProduct
} from "./forge-product";
import {
  FORGE_KINDS,
  isForgeKind,
  type ForgeHost,
  type ForgeHostStatus,
  type ForgeKind,
  type ForgeStatus
} from "./types";

/**
 * Whether a forge holds a usable credential for ONE named host.
 *
 * `ForgeStatus.loggedIn` summarizes the whole forge — the right question for a
 * settings pane, and the wrong one for a caller that is about to talk to a
 * specific instance. A machine signed in only to a self-managed GitLab can read
 * merge requests and still have nothing at all for gitlab.com, so a caller that
 * asked the summary and then queried gitlab.com would fail late instead of
 * saying what is missing.
 *
 * A host the probe did not cover falls back to the summary, deliberately. That
 * window is real: enumeration reports no host on a machine carrying only
 * `GITHUB_TOKEN`, and again for the seconds before it first lands, and treating
 * "not probed" as "signed out" there would block a caller whose credential
 * works. Absence is not evidence.
 */
export function forgeLoggedInAt(status: ForgeStatus, hostname: string): boolean {
  return forgeHostStatus(status, hostname)?.loggedIn ?? status.loggedIn;
}

/**
 * The reported entry for one host, matched the way every other layer matches.
 *
 * Canonicalized on both sides: `ForgeHostStatus.host` is written through
 * `canonicalForgeHostname`, while the caller's side is an arbitrary string — a
 * provider hostname, or one parsed off a remote, which lowercases but does not
 * strip `www.`. A raw `===` misses on that difference and the miss is silent,
 * falling through to the forge-wide summary, which is the permissive answer.
 */
function forgeHostStatus(
  status: ForgeStatus,
  hostname: string
): ForgeHostStatus | undefined {
  const key = canonicalForgeHostname(hostname) ?? hostname.trim().toLowerCase();
  return status.hosts.find((host) => host.host === key);
}

/**
 * Why a forge cannot answer for its SaaS instance, or null when it can.
 *
 * Three reasons, deliberately not two. "Switched off" is not "signed out": a
 * user who turned gitlab.com off in Settings is still signed in to it, and
 * telling them to run `glab auth login` names a remedy that cannot change
 * anything — the exact collapse `ForgeHostStatus.loggedIn` is documented to
 * avoid. One function so the clone dialog, the fork preflight and the clone
 * service's own gate cannot answer this differently, which they did.
 *
 * Prefer `forgeBlockAt`: those three all name an instance now, and this is the
 * special case where that instance happens to be the SaaS host.
 */
export function forgeSaasBlock(
  status: ForgeStatus | undefined
): ForgeBlock | null {
  if (status === undefined || !status.installed) return "cli_missing";
  return forgeBlockAt(status, forgeProduct(status.kind).saasHost);
}

/**
 * The same three reasons, asked about ONE named instance.
 *
 * `forgeSaasBlock` is this with the SaaS hostname filled in, and its comment
 * says why it was spelled out: a caller that reaches a provider for some other
 * instance has to come here instead and notice. That is now the clone and fork
 * paths, which carry the hostname so a self-managed project is not confirmed
 * against github.com/gitlab.com — and asking the SaaS question there would
 * block a machine signed in ONLY to its company instance, reporting "sign in"
 * about a credential it does not need.
 */
export function forgeBlockAt(
  status: ForgeStatus | undefined,
  hostname: string
): ForgeBlock | null {
  if (status === undefined || !status.installed) return "cli_missing";
  if (forgeHostStatus(status, hostname)?.enabled === false) return "host_off";
  return forgeLoggedInAt(status, hostname) ? null : "signed_out";
}

/**
 * Every host this forge reports is switched off.
 *
 * A configuration, not a fault — which is why it renders as a neutral "Off"
 * rather than a warning, and why it must not put the status cache on the
 * one-minute retry cadence reserved for something the user is actively fixing.
 * Shared so main's backoff and the pane's state machine cannot disagree about
 * what "off" means.
 */
export function forgeAllHostsOff(status: ForgeStatus): boolean {
  return (
    status.installed &&
    status.hosts.length > 0 &&
    status.hosts.every((host) => !host.enabled)
  );
}

/** Whether a forge can answer for its SaaS instance at all. */
export function forgeCanAnswerSaas(status: ForgeStatus | undefined): boolean {
  return forgeSaasBlock(status) === null;
}

/**
 * The credential for the forge's SaaS instance.
 *
 * No longer what the clone and fork dialogs need: both now carry a hostname end
 * to end and ask `forgeBlockAt(status, hostname)` about the instance they
 * actually reached. This remains for the callers whose instance genuinely IS
 * the SaaS one — `repo:searchCloneSources` and `knownOwners`, which have no
 * hostname to pass. Reach for `forgeLoggedInAt` unless you can say why the
 * SaaS host is the right question.
 */
export function forgeLoggedInAtSaas(status: ForgeStatus): boolean {
  return forgeLoggedInAt(status, forgeProduct(status.kind).saasHost);
}

/** Why a forge is unusable. `host_off` is the user's own switch, so it must
 *  never be worded as a sign-in problem. */
export type ForgeBlock = "cli_missing" | "host_off" | "signed_out";

/** A git remote URL resolved to the forge it points at. `hostname` is kept
 *  even for `other`: a self-hosted instance is still worth naming in the UI,
 *  and it is the only thing distinguishing two remotes that share a slug. */
export type ForgeRemote = {
  host: ForgeHost;
  hostname: string;
  owner: string;
  repo: string;
  nameWithOwner: string;
};

/** scp-style (`git@host:group/sub/repo.git`) and url-style remotes, with an
 *  optional user, an optional `.git`, and an optional trailing slash. */
const SCP = /^(?:[^@\s]+@)?([^\s:/]+):(.+?)(?:\.git)?\/?$/;
const URL_STYLE =
  /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i;

/** GitLab nests groups arbitrarily deep — `group/subgroup/team/repo` is one
 *  project. Everything before the last segment is the owner, which is exactly
 *  what `glab` accepts back as a project path. A product with no subgroups
 *  never has more than two segments, so the same split is correct there; the
 *  count comes back so the caller can hold it to its product's depth rule. */
function splitPath(
  path: string
): { owner: string; repo: string; segments: number } | null {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join("/");
  if (owner === "" || repo === "") return null;
  return { owner, repo, segments: segments.length };
}

/** Explicit host → forge mapping, for self-hosted instances no heuristic can
 *  identify. Mirrors `ForgeHostOverrides` in main's `forge/resolve.ts`. */
export type ForgeHostMap = Readonly<Record<string, ForgeKind>>;

/**
 * The one spelling of a hostname every layer must agree on.
 *
 * Config keys are written by the settings pane and read by host resolution; if
 * the two canonicalize differently, a setting persists under a key no lookup
 * ever matches and silently does nothing. Returns null for anything that is
 * not a bare hostname — a port, a path, or a space means the caller has a URL
 * or a typo, not a host.
 */
export function canonicalForgeHostname(value: string): string | null {
  // Every leading `www.`, not one: a single strip is not idempotent, so a
  // caller that canonicalizes before sending and a callee that canonicalizes
  // on receipt would disagree on `www.www.example.com` — and this function
  // exists precisely so those two agree byte-for-byte.
  const host = value.trim().toLowerCase().replace(/^(?:www\.)+/, "");
  if (host === "") return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return null;
  }
  return host;
}

/**
 * Which forge a hostname belongs to. `other` means "cannot be certain", which
 * is the honest answer for a self-hosted instance until `overrides` says
 * otherwise — a wrong guess sends API calls at the wrong product.
 *
 * A hostname is never evidence beyond the two SaaS names. `gitlab.*` used to
 * be read as GitLab on the strength of the naming convention, and that made
 * this function disagree with `ForgeHosts` in main, which enumerates hosts
 * from `gh`/`glab` sign-ins and from what the user added by hand. One answer
 * beats two: a self-managed instance is known because somebody signed in to it
 * or named it, and `overrides` is how that knowledge reaches here.
 *
 * This is the ONE classifier: main's `classifyHost` delegates here, so the
 * renderer's dialogs and the main process can never disagree about which
 * provider owns a remote. Callers that have the host list must pass it —
 * without it this is only ever `github.com`, `gitlab.com`, or `other`.
 */
export function classifyForgeHost(
  hostname: string,
  overrides: ForgeHostMap = {}
): ForgeHost {
  const normalized = hostname.trim().toLowerCase().replace(/^www\./, "");
  // `Object.hasOwn`, not a bare index: `overrides` is a plain object, and a
  // hostname is attacker-adjacent input straight out of a git remote. A single
  // label of `constructor` or `__proto__` — both legal intranet hostnames —
  // otherwise returns an inherited member, so `host` comes back as the `Object`
  // function rather than a ForgeHost and dies at the IPC boundary, where a
  // function is not structured-cloneable.
  if (Object.hasOwn(overrides, normalized)) {
    // `isForgeKind`, not `!== undefined`: the map is built from settings.json,
    // which nothing validates, and it crosses IPC to the renderer's dialogs.
    // Returning a kind no product claims makes this function's `ForgeHost`
    // return type a lie, and every caller that indexes a per-product table
    // with it then fails on a value the type system promised was safe.
    const override = overrides[normalized];
    if (isForgeKind(override)) return override;
  }
  // Each product's SaaS host, read off the registry rather than written out
  // twice. This is the ONLY thing a hostname is evidence of: anything else
  // self-managed must be enumerated or added by hand, which is what the
  // `overrides` map above carries.
  return (
    FORGE_KINDS.find((kind) => FORGE_PRODUCTS[kind].saasHost === normalized) ??
    "other"
  );
}

/** Parse any git remote URL into the forge coordinates it names.
 *
 *  `overrides` carries the known host list — `ForgeHosts.overrides()` in main,
 *  and in the renderer the very same map, shipped over `forge:hosts` and read
 *  by `useForgeHostMap`. Never rebuild it from that response's settings ROWS:
 *  the two are different sets, and the difference is exactly the hosts an env
 *  allowlist names. Omitting it resolves every
 *  self-managed instance to `other`, which is a silent loss of forge features
 *  rather than an error, so omit it only where the host is checked separately
 *  (`parseGitHubRemote` accepts github.com and nothing else). */
export function parseForgeRemote(
  url: string,
  overrides: ForgeHostMap = {}
): ForgeRemote | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  // url-style is tried first: `ssh://git@host:22/o/r` also matches the
  // scp pattern, and would yield a port number as the path.
  const matched = URL_STYLE.exec(trimmed) ?? SCP.exec(trimmed);
  if (matched === null) return null;
  const hostname = matched[1];
  const path = matched[2];
  if (hostname === undefined || path === undefined) return null;
  // A local path (`/srv/git/repo.git`, `C:\repos\thing`) has no forge.
  if (hostname === "" || hostname.includes("\\")) return null;

  const split = splitPath(path);
  if (split === null) return null;
  const host = classifyForgeHost(hostname, overrides);
  // A product with no subgroups has projects that are exactly `owner/repo`; a
  // deeper path there is a wiki, a gist, or a page URL that merely looks like a
  // repository (`.../repo/issues`), and reading it as a project would send a
  // clone at a URL that cannot exist. A product that nests keeps whatever depth
  // it was given. `other` is unconstrained: we do not know its rules.
  if (host !== "other" && !forgeAllowsPathDepth(host, split.segments)) {
    return null;
  }
  return {
    host,
    // The SAME spelling every other layer uses. This string is not cosmetic:
    // it travels over IPC as the `hostname` field and keys
    // `ForgeRepoRegistry.byHost`, so a lone `www.` here builds a second
    // provider that runs `gh api --hostname www.github.com` and cannot
    // succeed. `canonicalForgeHostname` rejects a shape it does not recognise,
    // and the lowercase form is the honest fallback for those.
    hostname: canonicalForgeHostname(hostname) ?? hostname.trim().toLowerCase(),
    owner: split.owner,
    repo: split.repo,
    nameWithOwner: `${split.owner}/${split.repo}`
  };
}

/** The browser URL for a repository on a forge. */
export function forgeWebUrl(hostname: string, nameWithOwner: string): string {
  return `https://${hostname}/${nameWithOwner}`;
}

/** Whether a hostname is safe to interpolate into a git remote URL. */
export function isSafeForgeHostname(hostname: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname);
}

/** Whether a project path is safe to interpolate into a git remote URL.
 *  GitLab subgroups make this more than `owner/name`, but every segment is
 *  still restricted to what both forges accept in a path. */
export function isSafeProjectPath(nameWithOwner: string): boolean {
  const segments = nameWithOwner.split("/");
  return (
    segments.length >= 2 &&
    segments.length <= 8 &&
    segments.every((segment) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment))
  );
}

/** The SSH and HTTPS clone URLs for a project on a forge. Both forges use the
 *  same two shapes, so this is not host-specific. */
export function forgeCloneUrls(
  hostname: string,
  nameWithOwner: string
): { sshUrl: string; httpsUrl: string } {
  return {
    sshUrl: `git@${hostname}:${nameWithOwner}.git`,
    httpsUrl: `https://${hostname}/${nameWithOwner}.git`
  };
}
