import {
  forgeWebUrl,
  isForgeKind,
  isSafeForgeHostname,
  isSafeProjectPath,
  type ForgeHost
} from "@pwrgit/shared";

/** Documented repository browsing, independent of account/review integration.
 * V8 identifies this host as its repository: https://v8.dev/docs/source-code.
 * Do not infer Gerrit support (or browser routes on other hosts) from it. */
export function repositoryBrowserLabel(hostname: string): string | null {
  return hostname === "chromium.googlesource.com" ? "Chromium Googlesource" : null;
}

export function repositoryBrowserUrl(repository: {
  host: ForgeHost;
  hostname: string;
  nameWithOwner: string;
}): string | null {
  const { host, hostname, nameWithOwner } = repository;
  if (!isForgeKind(host) && repositoryBrowserLabel(hostname) === null) return null;
  if (!isSafeForgeHostname(hostname) || !isSafeProjectPath(nameWithOwner)) return null;
  return forgeWebUrl(hostname, nameWithOwner);
}
