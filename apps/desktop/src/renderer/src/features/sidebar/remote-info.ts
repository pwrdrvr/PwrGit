import {
  parseForgeRemote,
  type RepoIdentity,
  type ForgeHostMap
} from "@pwrgit/shared";

import { repositoryBrowserUrl } from "./repository-browser";

/**
 * How git reaches a remote, read off the URL rather than guessed.
 *
 * It is the half of a remote a user cannot see anywhere in PwrGit today and
 * the half that explains the most: an `https://` origin is why a push asks for
 * a credential helper, and an scp-style `git@` one is why it asks for a key.
 * `local` covers a path or a `file://` URL — a bare repo on a disk or a NAS is
 * a perfectly ordinary remote and naming it "SSH" would be a lie.
 */
export type RemoteWire = "SSH" | "HTTPS" | "HTTP" | "git" | "local";

export function remoteWire(url: string): RemoteWire {
  const trimmed = url.trim();
  if (/^ssh:\/\//i.test(trimmed)) return "SSH";
  if (/^https:\/\//i.test(trimmed)) return "HTTPS";
  if (/^http:\/\//i.test(trimmed)) return "HTTP";
  if (/^git:\/\//i.test(trimmed)) return "git";
  if (/^file:\/\//i.test(trimmed)) return "local";
  // scp-style — `user@host:path`, the shape `git@github.com:o/r.git` takes.
  // Anchored on a host before the colon so a Windows path (`C:\repos\x`) and
  // a bare POSIX path both fall through to `local`.
  if (/^(?:[^@\s\\]+@)?[^\s:/\\]+:(?![\\/])/.test(trimmed)) return "SSH";
  return "local";
}

/**
 * Where a remote lives, in one sentence: the wire and the host.
 *
 * Deliberately not "on GitHub". A git remote is never evidence of a forge
 * (`main/forge/AGENTS.md`), so this names the HOST, which is a fact the URL
 * actually carries, and leaves claiming a product to the forge chip beside it.
 */
export function remoteWhere(url: string): string {
  const wire = remoteWire(url);
  const host = remoteHostname(url);
  if (host === null) return wire === "local" ? "A local path" : `Over ${wire}`;
  return wire === "local" ? `At ${host}` : `${wire} to ${host}`;
}

/** The hostname a remote URL names, or null when it names none (a path). */
export function remoteHostname(url: string): string | null {
  const trimmed = url.trim();
  const urlStyle = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)/i.exec(trimmed);
  if (urlStyle?.[1] !== undefined) return urlStyle[1].toLowerCase();
  const scp = /^(?:[^@\s\\]+@)?([^\s:/\\]+):(?![\\/])/.exec(trimmed);
  if (scp?.[1] !== undefined) return scp[1].toLowerCase();
  return null;
}

/**
 * The page to open for a remote, or null when there is nothing honest to open.
 *
 * Known integrations and explicitly documented repository browsers only.
 * Browser recognition does not grant account, fork, or review capabilities.
 */
export function remoteWebUrl(
  url: string,
  overrides: ForgeHostMap = {}
): string | null {
  const parsed = parseForgeRemote(url, overrides);
  return parsed === null ? null : repositoryBrowserUrl(parsed);
}

/**
 * The fetch and push URLs worth showing for a remote.
 *
 * Git keeps them separately and they are usually the same string; a remote
 * that fetches from one place and pushes to another is exactly the case a
 * single displayed URL would misreport, so say both only when they differ.
 */
export function remoteUrlLines(remote: {
  fetchUrl: string;
  pushUrl: string;
}): { label: string; url: string }[] {
  const { fetchUrl, pushUrl } = remote;
  if (pushUrl === "" || pushUrl === fetchUrl) {
    return [{ label: "URL", url: fetchUrl }];
  }
  return [
    { label: "Fetch", url: fetchUrl },
    { label: "Push", url: pushUrl }
  ];
}

/** Origin's repository page, independent of whether its integration is enabled. */
export function repoWebUrl(identity: RepoIdentity | undefined): string | null {
  return identity === undefined ? null : repositoryBrowserUrl(identity);
}
