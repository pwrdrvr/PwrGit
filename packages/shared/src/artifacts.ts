/** Cloudflare's documented Git contract, verified 2026-10-10.
 * https://developers.cloudflare.com/artifacts/api/git-protocol/ */
export type ArtifactsRemote = {
  remote: string;
  hostname: string;
  namespace: string;
  repo: string;
};

/** Validation is not provider discovery: callers must explicitly register the host. */
export function parseArtifactsRemote(value: string): ArtifactsRemote | null {
  const match = /^https:\/\/([a-f0-9]{32}\.artifacts\.cloudflare\.net)\/git\/([A-Za-z0-9][A-Za-z0-9_.-]{1,62})\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.git$/i.exec(value.trim());
  if (match === null) return null;
  const [, hostname, namespace, repo] = match;
  if (!hostname || !namespace || !repo) return null;
  // Dot segments and URL escapes never name a documented repository.
  if (namespace === "." || namespace === ".." || repo === "." || repo === "..") return null;
  return { remote: `https://${hostname.toLowerCase()}/git/${namespace}/${repo}.git`, hostname: hostname.toLowerCase(), namespace, repo };
}

export function artifactsTokenExpiry(token: string): number | null {
  const match = /^art_v1_[a-fA-F0-9]{40}\?expires=([0-9]{1,12})$/.exec(token);
  if (match === null) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Metadata only: the token never crosses a read command or event. */
export type ArtifactsCredential = {
  remote: string;
  expiresAt: number;
  expired: boolean;
};
export type ArtifactsCredentialStatus = {
  secureStorageAvailable: boolean;
  credentials: ArtifactsCredential[];
};
