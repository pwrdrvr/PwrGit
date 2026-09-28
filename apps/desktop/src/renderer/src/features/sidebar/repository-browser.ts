import { forgeProduct, forgeWebUrl, gerritReviewUrl, GERRIT_SITES, isForgeKind, isSafeForgeHostname, isSafeProjectPath, type ForgeHost } from "@pwrgit/shared";

export function repositoryBrowserUrl(repository: { host: ForgeHost; hostname: string; nameWithOwner: string }, reviewUrls: Readonly<Record<string, string>> = {}): string | null {
  const { host, hostname, nameWithOwner } = repository;
  if (!isForgeKind(host) || !isSafeForgeHostname(hostname) || !isSafeProjectPath(nameWithOwner, host)) return null;
  if (forgeProduct(host).reviewModel === "patchset") {
    const site = GERRIT_SITES[hostname];
    if (site !== undefined && site.browserUrl !== site.reviewUrl) return forgeWebUrl(hostname, nameWithOwner);
    try { return `${gerritReviewUrl(hostname, reviewUrls[hostname])}/q/${encodeURIComponent(`project:${nameWithOwner}`)}`; }
    catch { return null; }
  }
  return forgeWebUrl(hostname, nameWithOwner);
}
