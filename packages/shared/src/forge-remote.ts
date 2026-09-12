import type { ForgeHost, ForgeKind, ForgeStatus } from "./types";

/**
 * The hosted instance of each forge.
 *
 * The one host `ForgeHosts.kindFor` recognises without enumeration, which makes
 * it both the fallback the status probe falls back to when no CLI reports an
 * account and the one host whose sign-in command needs no `--hostname`. Shared
 * because main probes it and the settings pane words a command about it; two
 * copies would drift into printing a command for a host nothing probed.
 */
export const FORGE_SAAS_HOST: Readonly<Record<ForgeKind, string>> = {
  github: "github.com",
  gitlab: "gitlab.com"
};

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
  return (
    status.hosts.find((host) => host.host === hostname)?.loggedIn ??
    status.loggedIn
  );
}

/**
 * The credential for the forge's SaaS instance.
 *
 * What the clone and fork dialogs need: both reach their provider through
 * `ForgeRepoRegistry.get(kind)` with no hostname, which is the SaaS instance, so
 * the SaaS host is the one whose sign-in state decides whether they can do
 * anything. Spelled out rather than left as `status.loggedIn` so that widening
 * either dialog to other hosts has to change this line and notice.
 */
export function forgeLoggedInAtSaas(status: ForgeStatus): boolean {
  return forgeLoggedInAt(status, FORGE_SAAS_HOST[status.kind]);
}

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
 *  what `glab` accepts back as a project path. GitHub never has more than
 *  two segments, so the same split is correct there. */
function splitPath(path: string): { owner: string; repo: string } | null {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join("/");
  if (owner === "" || repo === "") return null;
  return { owner, repo };
}

/** Explicit host → forge mapping, for self-hosted instances no heuristic can
 *  identify. Mirrors `ForgeHostOverrides` in main's `forge/resolve.ts`. */
export type ForgeHostMap = Readonly<Record<string, "github" | "gitlab">>;

/**
 * Which forge a hostname belongs to. `other` means "cannot be certain", which
 * is the honest answer for a self-hosted instance until an override says
 * otherwise — a wrong guess sends API calls at the wrong product.
 *
 * This is the ONE classifier: main's `classifyHost` delegates here, so the
 * renderer's dialogs and the main process can never disagree about which
 * provider owns a remote.
 */
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
  const host = value.trim().toLowerCase().replace(/^www\./, "");
  if (host === "") return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return null;
  }
  return host;
}

export function classifyForgeHost(
  hostname: string,
  overrides: ForgeHostMap = {}
): ForgeHost {
  const normalized = hostname.trim().toLowerCase().replace(/^www\./, "");
  const override = overrides[normalized];
  if (override !== undefined) return override;
  if (normalized === "github.com") return "github";
  if (normalized === "gitlab.com") return "gitlab";
  if (normalized.startsWith("gitlab.")) return "gitlab";
  return "other";
}

/** Parse any git remote URL into the forge coordinates it names. */
export function parseForgeRemote(url: string): ForgeRemote | null {
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
  const host = classifyForgeHost(hostname);
  // GitHub has no subgroups: a project is always exactly `owner/repo`. A
  // deeper path is a wiki, a gist, or a page URL that merely looks like a
  // repository (`.../repo/issues`), and reading it as a project would send a
  // clone at a URL that cannot exist. GitLab nests arbitrarily, so it keeps
  // whatever depth it was given.
  if (host === "github" && split.owner.includes("/")) return null;
  return {
    host,
    hostname: hostname.toLowerCase(),
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
